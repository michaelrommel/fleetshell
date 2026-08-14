import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { localDb, globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { hashPassword } from '$lib/server/password';

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

type PersonaRow = {
	user_id: string; firstname: string; lastname: string;
	role_label: string | null; is_admin: boolean; home_region: string; group_count: number;
};
type AccountRow = {
	account_id: string; username: string; email: string; display_name: string | null; identity_count: number;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const q = (url.searchParams.get('q') ?? '').trim();
	const selPersona = url.searchParams.get('persona');
	const selAccount = url.searchParams.get('account');

	// Persona list: search when q given, else the account-linked (test) personas.
	const personas = q
		? await localDb<PersonaRow[]>`
			SELECT u.user_id, u.firstname, u.lastname, u.role_label, u.is_admin, u.home_region,
			       (SELECT count(*) FROM group_membership m WHERE m.user_id = u.user_id)::int AS group_count
			FROM app_user u
			WHERE u.firstname ILIKE ${'%' + q + '%'} OR u.lastname ILIKE ${'%' + q + '%'}
			   OR u.user_id ILIKE ${'%' + q + '%'} OR u.role_label ILIKE ${'%' + q + '%'}
			ORDER BY u.lastname, u.firstname LIMIT 100`
		: await localDb<PersonaRow[]>`
			SELECT u.user_id, u.firstname, u.lastname, u.role_label, u.is_admin, u.home_region,
			       (SELECT count(*) FROM group_membership m WHERE m.user_id = u.user_id)::int AS group_count
			FROM app_user u
			WHERE u.user_id IN (SELECT user_id FROM account_identity)
			ORDER BY u.lastname, u.firstname LIMIT 100`;

	const accounts = await localDb<AccountRow[]>`
		SELECT a.account_id, a.username, a.email, a.display_name,
		       (SELECT count(*) FROM account_identity ai WHERE ai.account_id = a.account_id)::int AS identity_count
		FROM login_account a ORDER BY a.username`;

	// Selected persona detail: its group memberships resolved to labels (global).
	let personaDetail: PersonaRow | null = null;
	let memberships: { group_id: string; label: string }[] = [];
	if (selPersona) {
		[personaDetail] = await localDb<PersonaRow[]>`
			SELECT u.user_id, u.firstname, u.lastname, u.role_label, u.is_admin, u.home_region, 0 AS group_count
			FROM app_user u WHERE u.user_id = ${selPersona}`;
		const gids = (await localDb<{ group_id: string }[]>`
			SELECT group_id::text AS group_id FROM group_membership WHERE user_id = ${selPersona}`
		).map((r) => r.group_id);
		if (gids.length) {
			const labels = await globalDb<{ group_id: string; label: string }[]>`
				SELECT group_id::text AS group_id, label FROM principal_group
				WHERE group_id = ANY(${gids}::uuid[])`;
			const byId = new Map(labels.map((l) => [l.group_id, l.label]));
			memberships = gids.map((g) => ({ group_id: g, label: byId.get(g) ?? '(unknown)' }))
				.sort((a, b) => a.label.localeCompare(b.label));
		}
	}

	// Selected account detail: linked personas.
	let accountDetail: AccountRow | null = null;
	let linked: PersonaRow[] = [];
	if (selAccount) {
		[accountDetail] = await localDb<AccountRow[]>`
			SELECT a.account_id, a.username, a.email, a.display_name, 0 AS identity_count
			FROM login_account a WHERE a.account_id = ${selAccount}`;
		linked = await localDb<PersonaRow[]>`
			SELECT u.user_id, u.firstname, u.lastname, u.role_label, u.is_admin, u.home_region, 0 AS group_count
			FROM account_identity ai JOIN app_user u ON u.user_id = ai.user_id
			WHERE ai.account_id = ${selAccount}
			ORDER BY u.is_admin DESC, u.lastname, u.firstname`;
	}

	return { q, personas, accounts, selPersona, selAccount, personaDetail, memberships, accountDetail, linked };
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
		throw redirect(303, `${base}/administration/users?persona=${encodeURIComponent(row.user_id)}`);
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
		throw redirect(303, `${base}/administration/users?persona=${encodeURIComponent(user_id)}`);
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
		throw redirect(303, `${base}/administration/users?persona=${encodeURIComponent(user_id)}`);
	},

	removeMembership: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const user_id = String(d.get('user_id') ?? '');
		const group_id = String(d.get('group_id') ?? '');
		await localDb`DELETE FROM group_membership WHERE user_id = ${user_id} AND group_id = ${group_id}::uuid`;
		throw redirect(303, `${base}/administration/users?persona=${encodeURIComponent(user_id)}`);
	},

	createAccount: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const username = String(d.get('username') ?? '').trim();
		const email = String(d.get('email') ?? '').trim();
		const password = String(d.get('password') ?? '');
		const display_name = String(d.get('display_name') ?? '').trim() || null;
		if (!username || !email || !password) return fail(400, { error: 'Username, email and password required.' });
		const password_hash = await hashPassword(password);
		let accountId: string;
		try {
			const [row] = await localDb<{ account_id: string }[]>`
				INSERT INTO login_account (account_id, username, email, password_hash, display_name)
				VALUES ('acct:' || nextval('login_account_seq'), ${username}, ${email}, ${password_hash}, ${display_name})
				RETURNING account_id`;
			accountId = row.account_id;
		} catch {
			return fail(409, { error: 'Username or email already exists.' });
		}
		throw redirect(303, `${base}/administration/users?account=${encodeURIComponent(accountId)}`);
	},

	linkIdentity: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const account_id = String(d.get('account_id') ?? '');
		const user_id = String(d.get('user_id') ?? '').trim();
		if (!account_id || !user_id) return fail(400, { error: 'Account and persona required.' });
		const [exists] = await localDb<{ ok: boolean }[]>`SELECT true AS ok FROM app_user WHERE user_id = ${user_id}`;
		if (!exists) return fail(404, { error: 'No such persona user_id.' });
		await localDb`
			INSERT INTO account_identity (account_id, user_id) VALUES (${account_id}, ${user_id})
			ON CONFLICT (account_id, user_id) DO NOTHING`;
		throw redirect(303, `${base}/administration/users?account=${encodeURIComponent(account_id)}`);
	},

	unlinkIdentity: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const account_id = String(d.get('account_id') ?? '');
		const user_id = String(d.get('user_id') ?? '');
		await localDb`DELETE FROM account_identity WHERE account_id = ${account_id} AND user_id = ${user_id}`;
		throw redirect(303, `${base}/administration/users?account=${encodeURIComponent(account_id)}`);
	},
};
