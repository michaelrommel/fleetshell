import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb, localDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';

const MEMBER_LIMIT = 50;

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

type TreeNode = { group_id: string; label: string; parent_id: string | null; grant_count: number; member_count: number };
type GroupRow = { group_id: string; label: string; home_region: string };
type GrantRow = {
	grant_id: string; role_name: string; scope_kind: string;
	region: string; product: string; customer: string; site: string; single_label: string;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const sel = url.searchParams.get('sel');
	const isNew = url.searchParams.get('new') === '1';
	const mq = (url.searchParams.get('mq') ?? '').trim(); // member filter within a group

	// The full org-group tree (excludes legacy per-person 'user:' groups).
	const raw = await globalDb<{ group_id: string; label: string; parent_id: string | null; grant_count: number }[]>`
		SELECT pg.group_id::text AS group_id, pg.label, pg.parent_id::text AS parent_id,
		       (SELECT count(*) FROM authz_grant g WHERE g.group_id = pg.group_id)::int AS grant_count
		FROM principal_group pg
		WHERE pg.label NOT LIKE 'user:%'
		ORDER BY pg.label`;
	const mcounts = await localDb<{ group_id: string; n: number }[]>`
		SELECT group_id::text AS group_id, count(*)::int AS n FROM group_membership GROUP BY group_id`;
	const mById = new Map(mcounts.map((c) => [c.group_id, c.n]));
	const nodes: TreeNode[] = raw.map((n) => ({ ...n, member_count: mById.get(n.group_id) ?? 0 }));

	let detail: GroupRow | null = null;
	let grants: GrantRow[] = [];
	let members: { user_id: string; firstname: string; lastname: string; role_label: string | null }[] = [];
	let memberTotal = 0;
	if (sel) {
		[detail] = await globalDb<GroupRow[]>`
			SELECT pg.group_id::text AS group_id, pg.label, pg.home_region
			FROM principal_group pg WHERE pg.group_id = ${sel}`;
		if (detail) {
			grants = await globalDb<GrantRow[]>`
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
				  COALESCE(s.label, '') AS single_label
				FROM authz_grant g
				JOIN authz_role r  ON r.id = g.role_id
				JOIN authz_scope s ON s.id = g.scope_id
				WHERE g.group_id = ${sel}
				ORDER BY r.name, s.kind, region, product`;
			[{ n: memberTotal }] = await localDb<{ n: number }[]>`
				SELECT count(*)::int AS n FROM group_membership WHERE group_id = ${sel}::uuid`;
			const mfilter = mq ? localDb`AND (u.firstname ILIKE ${'%' + mq + '%'} OR u.lastname ILIKE ${'%' + mq + '%'})` : localDb``;
			members = await localDb<{ user_id: string; firstname: string; lastname: string; role_label: string | null }[]>`
				SELECT u.user_id, u.firstname, u.lastname, u.role_label
				FROM group_membership m JOIN app_user u ON u.user_id = m.user_id
				WHERE m.group_id = ${sel}::uuid ${mfilter}
				ORDER BY u.lastname, u.firstname LIMIT ${MEMBER_LIMIT}`;
		}
	}

	return { nodes, sel, isNew, detail, grants, members, memberTotal, mq };
};

export const actions: Actions = {
	createGroup: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const label = String(d.get('label') ?? '').trim();
		const home_region = String(d.get('home_region') ?? 'eu-west-2').trim() || 'eu-west-2';
		if (!label) return fail(400, { error: 'Group label required.' });
		// Flat group: single-segment ltree path from a fresh uuid (matches import).
		const [row] = await globalDb<{ group_id: string }[]>`
			INSERT INTO principal_group (home_region, label, path)
			VALUES (${home_region}, ${label}, ('g' || replace(gen_random_uuid()::text, '-', ''))::ltree)
			RETURNING group_id::text AS group_id`;
		throw redirect(303, `${base}/administration/groups?sel=${encodeURIComponent(row.group_id)}`);
	},

	renameGroup: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		const label = String(d.get('label') ?? '').trim();
		if (!group_id || !label) return fail(400, { error: 'Label required.' });
		await globalDb`UPDATE principal_group SET label = ${label} WHERE group_id = ${group_id}`;
		throw redirect(303, `${base}/administration/groups?sel=${encodeURIComponent(group_id)}`);
	},

	addMember: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		const user_id = String(d.get('user_id') ?? '').trim();
		if (!group_id || !user_id) return fail(400, { error: 'Group and persona required.' });
		const [ok] = await localDb<{ ok: boolean }[]>`SELECT true AS ok FROM app_user WHERE user_id = ${user_id}`;
		if (!ok) return fail(404, { error: 'No such persona user_id.' });
		await localDb`
			INSERT INTO group_membership (group_id, user_id, added_by)
			VALUES (${group_id}::uuid, ${user_id}, ${locals.userId ?? null})
			ON CONFLICT (group_id, user_id) DO NOTHING`;
		throw redirect(303, `${base}/administration/groups?sel=${encodeURIComponent(group_id)}`);
	},

	removeMember: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		const user_id = String(d.get('user_id') ?? '');
		await localDb`DELETE FROM group_membership WHERE group_id = ${group_id}::uuid AND user_id = ${user_id}`;
		throw redirect(303, `${base}/administration/groups?sel=${encodeURIComponent(group_id)}`);
	},

	deleteGroup: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		if (!group_id) return fail(400, { error: 'Group required.' });
		// Grants on the group cascade (global). Membership is cross-DB (no FK), so
		// clean the local rows explicitly.
		await globalDb`DELETE FROM principal_group WHERE group_id = ${group_id}`;
		await localDb`DELETE FROM group_membership WHERE group_id = ${group_id}::uuid`;
		throw redirect(303, `${base}/administration/groups`);
	},
};
