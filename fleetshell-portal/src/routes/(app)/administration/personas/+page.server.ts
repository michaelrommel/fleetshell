import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { localDb, globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { invalidateUserGroups } from '$lib/server/authz';

const PAGE_SIZE = 50;

// Keyset cursor over (lastname, firstname, user_id) encoded in the URL.
type Key = [string, string, string];
function encodeKey(k: Key): string { return Buffer.from(JSON.stringify(k)).toString('base64url'); }
function decodeKey(s: string | null): Key | null {
	if (!s) return null;
	try {
		const a = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
		return Array.isArray(a) && a.length === 3 ? (a as Key) : null;
	} catch { return null; }
}

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

const GRANT_LIMIT = 500;

type EffectiveGrant = {
	grant_id: string; role_name: string; scope_kind: string;
	region: string; product: string; customer: string; site: string; single_label: string;
	source_group: string; inherited: boolean;
};

type PersonaRow = {
	user_id: string; firstname: string; lastname: string;
	role_label: string | null; is_admin: boolean; home_region: string; group_count: number;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const q = (url.searchParams.get('q') ?? '').trim();
	const sel = url.searchParams.get('sel');
	const isNew = url.searchParams.get('new') === '1';
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const after = decodeKey(url.searchParams.get('after'));
	const before = decodeKey(url.searchParams.get('before'));
	const like = '%' + q + '%';

	// Reusable filter fragment (search over name / id / role).
	const search = q
		? localDb`AND (u.firstname ILIKE ${like} OR u.lastname ILIKE ${like} OR u.user_id ILIKE ${like} OR u.role_label ILIKE ${like})`
		: localDb``;

	const [{ total }] = await localDb<{ total: number }[]>`
		SELECT count(*)::int AS total FROM app_user u WHERE true ${search}`;

	// Keyset: forward with `after`, backward with `before` (reversed then flipped).
	let cursor = localDb``;
	let order = localDb`u.lastname ASC, u.firstname ASC, u.user_id ASC`;
	let reverse = false;
	if (before) {
		cursor = localDb`AND (u.lastname, u.firstname, u.user_id) < (${before[0]}, ${before[1]}, ${before[2]})`;
		order = localDb`u.lastname DESC, u.firstname DESC, u.user_id DESC`;
		reverse = true;
	} else if (after) {
		cursor = localDb`AND (u.lastname, u.firstname, u.user_id) > (${after[0]}, ${after[1]}, ${after[2]})`;
	}

	let personas: PersonaRow[] = await localDb<PersonaRow[]>`
		SELECT u.user_id, u.firstname, u.lastname, u.role_label, u.is_admin, u.home_region,
		       (SELECT count(*) FROM group_membership m WHERE m.user_id = u.user_id)::int AS group_count
		FROM app_user u
		WHERE true ${search} ${cursor}
		ORDER BY ${order}
		LIMIT ${PAGE_SIZE}`;
	if (reverse) personas = personas.reverse();

	const firstKey: Key | null = personas.length
		? [personas[0].lastname, personas[0].firstname, personas[0].user_id] : null;
	const lastKey: Key | null = personas.length
		? [personas[personas.length - 1].lastname, personas[personas.length - 1].firstname, personas[personas.length - 1].user_id] : null;
	const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
	const to = (page - 1) * PAGE_SIZE + personas.length;

	let detail: PersonaRow | null = null;
	let memberships: { group_id: string; label: string }[] = [];
	let effectiveGrants: EffectiveGrant[] = [];
	let grantTotal = 0;
	if (sel) {
		[detail] = await localDb<PersonaRow[]>`
			SELECT u.user_id, u.firstname, u.lastname, u.role_label, u.is_admin, u.home_region, 0 AS group_count
			FROM app_user u WHERE u.user_id = ${sel}`;
		const gids = (await localDb<{ group_id: string }[]>`
			SELECT group_id::text AS group_id FROM group_membership WHERE user_id = ${sel}`
		).map((r) => r.group_id);
		if (gids.length) {
			const labels = await globalDb<{ group_id: string; label: string }[]>`
				SELECT group_id::text AS group_id, label FROM principal_group
				WHERE group_id = ANY(${gids}::uuid[])`;
			const byId = new Map(labels.map((l) => [l.group_id, l.label]));
			memberships = gids.map((g) => ({ group_id: g, label: byId.get(g) ?? '(unknown)' }))
				.sort((a, b) => a.label.localeCompare(b.label));

			// Effective grants: grants on the joined groups + all ANCESTOR groups
			// (inheritance is ancestor-or-self -- same expansion as authz_fastpath).
			// Decoded so an investigator sees exactly which scope each grant carries
			// and which group it came from (direct vs inherited).
			const mg = globalDb`
				SELECT DISTINCT gg.group_id, gg.label, gg.path
				FROM principal_group ug
				JOIN principal_group gg ON gg.path @> ug.path OR gg.group_id = ug.group_id
				WHERE ug.group_id = ANY(${gids}::uuid[])`;
			[{ total: grantTotal }] = await globalDb<{ total: number }[]>`
				WITH mg AS (${mg})
				SELECT count(*)::int AS total FROM mg JOIN authz_grant g ON g.group_id = mg.group_id`;
			effectiveGrants = await globalDb<EffectiveGrant[]>`
				WITH mg AS (${mg})
				SELECT g.id::text AS grant_id, r.name AS role_name, s.kind AS scope_kind,
				  COALESCE((SELECT string_agg(reg.name, ', ') FROM authz_scope_constraint c
				            JOIN region reg ON reg.path = ANY(c.values::ltree[])
				            WHERE c.scope_id = s.id AND c.dimension = 'region_path'), 'ANY') AS region,
				  COALESCE((SELECT string_agg(
				              COALESCE((SELECT tp.name FROM product tp WHERE tp.path = subltree(p.path, 0, LEAST(nlevel(p.path), 2))), p.name)
				                || ' / ' || CASE WHEN nlevel(p.path) <= 2 THEN 'ANY' ELSE p.name END, ', ')
				            FROM authz_scope_constraint c
				            JOIN product p ON p.path = ANY(c.values::ltree[])
				            WHERE c.scope_id = s.id AND c.dimension = 'product_path'), 'ANY') AS product,
				  COALESCE((SELECT string_agg(cu.name, ', ') FROM authz_scope_constraint c
				            JOIN customer cu ON cu.id = ANY(c.values::uuid[])
				            WHERE c.scope_id = s.id AND c.dimension = 'customer_id'), 'ANY') AS customer,
				  COALESCE((SELECT string_agg(si.name, ', ') FROM authz_scope_constraint c
				            JOIN customer_site si ON si.id = ANY(c.values::uuid[])
				            WHERE c.scope_id = s.id AND c.dimension = 'site_id'), 'ANY') AS site,
				  COALESCE(s.label, '') AS single_label,
				  mg.label AS source_group,
				  (mg.group_id <> ALL(${gids}::uuid[])) AS inherited
				FROM mg
				JOIN authz_grant g ON g.group_id = mg.group_id
				JOIN authz_role r  ON r.id = g.role_id
				JOIN authz_scope s ON s.id = g.scope_id
				ORDER BY inherited, r.name, source_group, region, product
				LIMIT ${GRANT_LIMIT}`;
		}
	}

	return {
		q, page, total, from, to,
		hasPrev: page > 1,
		hasNext: page * PAGE_SIZE < total,
		prevCursor: firstKey ? encodeKey(firstKey) : null,
		nextCursor: lastKey ? encodeKey(lastKey) : null,
		personas, sel, isNew, detail, memberships, effectiveGrants, grantTotal, grantLimit: GRANT_LIMIT,
	};
};

export const actions: Actions = {
	createPersona: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const firstname = String(d.get('firstname') ?? '').trim();
		const lastname = String(d.get('lastname') ?? '').trim();
		const role_label = String(d.get('role_label') ?? '').trim() || null;
		const home_region = String(d.get('home_region') ?? 'eu-west-2').trim() || 'eu-west-2';
		const is_admin = d.get('is_admin') === 'on';
		if (!firstname || !lastname) return fail(400, { error: 'First and last name required.' });
		const [row] = await localDb<{ user_id: string }[]>`
			INSERT INTO app_user (user_id, home_region, firstname, lastname, role_label, is_admin)
			VALUES (split_part(${home_region}, '-', 1) || ':' || nextval('app_user_local_seq'),
			        ${home_region}, ${firstname}, ${lastname}, ${role_label}, ${is_admin})
			RETURNING user_id`;
		throw redirect(303, `${base}/administration/personas?sel=${encodeURIComponent(row.user_id)}`);
	},

	updatePersona: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const user_id = String(d.get('user_id') ?? '');
		const firstname = String(d.get('firstname') ?? '').trim();
		const lastname = String(d.get('lastname') ?? '').trim();
		const role_label = String(d.get('role_label') ?? '').trim() || null;
		const is_admin = d.get('is_admin') === 'on';
		if (!user_id || !firstname || !lastname) return fail(400, { error: 'Missing fields.' });
		await localDb`
			UPDATE app_user SET firstname = ${firstname}, lastname = ${lastname},
			       role_label = ${role_label}, is_admin = ${is_admin}, updated_at = now()
			WHERE user_id = ${user_id}`;
		throw redirect(303, `${base}/administration/personas?sel=${encodeURIComponent(user_id)}`);
	},

	addMembership: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const user_id = String(d.get('user_id') ?? '');
		const group_id = String(d.get('group_id') ?? '').trim();
		if (!user_id || !group_id) return fail(400, { error: 'Group required.' });
		await localDb`
			INSERT INTO group_membership (group_id, user_id, added_by)
			VALUES (${group_id}::uuid, ${user_id}, ${locals.userId ?? null})
			ON CONFLICT (group_id, user_id) DO NOTHING`;
		await invalidateUserGroups(user_id);
		throw redirect(303, `${base}/administration/personas?sel=${encodeURIComponent(user_id)}`);
	},

	removeMembership: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const user_id = String(d.get('user_id') ?? '');
		const group_id = String(d.get('group_id') ?? '');
		await localDb`DELETE FROM group_membership WHERE user_id = ${user_id} AND group_id = ${group_id}::uuid`;
		await invalidateUserGroups(user_id);
		throw redirect(303, `${base}/administration/personas?sel=${encodeURIComponent(user_id)}`);
	},

	deletePersona: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const user_id = String(d.get('user_id') ?? '');
		if (!user_id) return fail(400, { error: 'Persona required.' });
		// Block if this persona is some account's default (would break their login).
		const [{ n }] = await localDb<{ n: number }[]>`
			SELECT count(*)::int AS n FROM account_persona WHERE user_id = ${user_id} AND is_primary`;
		if (n > 0) {
			return fail(400, {
				error: `This persona is the default for ${n} account(s). Change or delete those accounts first.`,
			});
		}
		// group_membership + non-primary account_persona links cascade.
		await localDb`DELETE FROM app_user WHERE user_id = ${user_id}`;
		await invalidateUserGroups(user_id);
		throw redirect(303, `${base}/administration/personas`);
	},
};
