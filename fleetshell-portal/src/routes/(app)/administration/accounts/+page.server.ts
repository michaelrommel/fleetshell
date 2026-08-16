import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { localDb } from '$lib/server/db';
import { getPersona, listPersonas } from '$lib/server/identity';
import { hashPassword } from '$lib/server/password';

const PAGE_SIZE = 50;

// Keyset cursor over username (unique), encoded in the URL.
function encodeKey(k: string): string { return Buffer.from(k).toString('base64url'); }
function decodeKey(s: string | null): string | null {
	return s ? Buffer.from(s, 'base64url').toString('utf8') : null;
}

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

type AccountRow = {
	account_id: string; username: string; email: string; display_name: string | null; persona_count: number;
};

async function createPersona(
	firstname: string, lastname: string, role_label: string | null, home_region: string, is_admin: boolean,
): Promise<string> {
	const [p] = await localDb<{ user_id: string }[]>`
		INSERT INTO app_user (user_id, home_region, firstname, lastname, role_label, is_admin)
		VALUES (split_part(${home_region}, '-', 1) || ':' || nextval('app_user_local_seq'),
		        ${home_region}, ${firstname}, ${lastname}, ${role_label}, ${is_admin})
		RETURNING user_id`;
	return p.user_id;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const q = (url.searchParams.get('q') ?? '').trim();
	const sel = url.searchParams.get('account');
	const isNew = url.searchParams.get('new') === '1';
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const after = decodeKey(url.searchParams.get('after'));
	const before = decodeKey(url.searchParams.get('before'));
	const like = '%' + q + '%';

	const search = q
		? localDb`AND (a.username ILIKE ${like} OR a.email ILIKE ${like} OR a.display_name ILIKE ${like})`
		: localDb``;

	const [{ total }] = await localDb<{ total: number }[]>`
		SELECT count(*)::int AS total FROM login_account a WHERE true ${search}`;

	let cursor = localDb``;
	let order = localDb`a.username ASC`;
	let reverse = false;
	if (before) {
		cursor = localDb`AND a.username < ${before}`;
		order = localDb`a.username DESC`;
		reverse = true;
	} else if (after) {
		cursor = localDb`AND a.username > ${after}`;
	}

	let accounts: AccountRow[] = await localDb<AccountRow[]>`
		SELECT a.account_id, a.username, a.email, a.display_name,
		       (SELECT count(*) FROM account_persona ai WHERE ai.account_id = a.account_id)::int AS persona_count
		FROM login_account a
		WHERE true ${search} ${cursor}
		ORDER BY ${order} LIMIT ${PAGE_SIZE}`;
	if (reverse) accounts = accounts.reverse();

	const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
	const to = (page - 1) * PAGE_SIZE + accounts.length;

	let detail: AccountRow | null = null;
	let linked: Awaited<ReturnType<typeof listPersonas>> = [];
	if (sel) {
		[detail] = await localDb<AccountRow[]>`
			SELECT a.account_id, a.username, a.email, a.display_name, 0 AS persona_count
			FROM login_account a WHERE a.account_id = ${sel}`;
		linked = await listPersonas(sel);
	}

	return {
		q, page, total, from, to,
		hasPrev: page > 1,
		hasNext: page * PAGE_SIZE < total,
		prevCursor: accounts.length ? encodeKey(accounts[0].username) : null,
		nextCursor: accounts.length ? encodeKey(accounts[accounts.length - 1].username) : null,
		accounts, sel, isNew, detail, linked,
	};
};

export const actions: Actions = {
	createAccount: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const username = String(d.get('username') ?? '').trim();
		const email = String(d.get('email') ?? '').trim();
		const password = String(d.get('password') ?? '');
		const display_name = String(d.get('display_name') ?? '').trim() || null;
		if (!username || !email || !password) return fail(400, { error: 'Username, email and password required.' });

		// Default persona: either an existing persona, or a freshly created one.
		const mode = String(d.get('default_mode') ?? 'new');
		let primaryUserId: string;
		if (mode === 'existing') {
			primaryUserId = String(d.get('default_user_id') ?? '').trim();
			if (!primaryUserId) return fail(400, { error: 'Pick an existing persona as the default persona.' });
			const [ok] = await localDb<{ ok: boolean }[]>`SELECT true AS ok FROM app_user WHERE user_id = ${primaryUserId}`;
			if (!ok) return fail(404, { error: 'No such persona user_id.' });
		} else {
			const firstname = String(d.get('firstname') ?? '').trim();
			const lastname = String(d.get('lastname') ?? '').trim();
			if (!firstname || !lastname) return fail(400, { error: 'The new default persona needs a first and last name.' });
			const role_label = String(d.get('role_label') ?? '').trim() || null;
			const home_region = String(d.get('home_region') ?? 'eu-west-2').trim() || 'eu-west-2';
			const is_admin = d.get('is_admin') === 'on';
			primaryUserId = await createPersona(firstname, lastname, role_label, home_region, is_admin);
		}

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
		await localDb`
			INSERT INTO account_persona (account_id, user_id, is_primary)
			VALUES (${accountId}, ${primaryUserId}, true)`;
		throw redirect(303, `${base}/administration/accounts?account=${encodeURIComponent(accountId)}`);
	},

	updateAccount: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const account_id = String(d.get('account_id') ?? '');
		const email = String(d.get('email') ?? '').trim();
		const display_name = String(d.get('display_name') ?? '').trim() || null;
		const password = String(d.get('password') ?? '');
		if (!account_id || !email) return fail(400, { error: 'Email required.' });
		if (password) {
			const password_hash = await hashPassword(password);
			await localDb`UPDATE login_account SET email = ${email}, display_name = ${display_name},
				password_hash = ${password_hash}, updated_at = now() WHERE account_id = ${account_id}`;
		} else {
			await localDb`UPDATE login_account SET email = ${email}, display_name = ${display_name},
				updated_at = now() WHERE account_id = ${account_id}`;
		}
		throw redirect(303, `${base}/administration/accounts?account=${encodeURIComponent(account_id)}`);
	},

	linkPersona: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const account_id = String(d.get('account_id') ?? '');
		const user_id = String(d.get('user_id') ?? '').trim();
		if (!account_id || !user_id) return fail(400, { error: 'Account and persona required.' });
		const [exists] = await localDb<{ ok: boolean }[]>`SELECT true AS ok FROM app_user WHERE user_id = ${user_id}`;
		if (!exists) return fail(404, { error: 'No such persona user_id.' });
		await localDb`
			INSERT INTO account_persona (account_id, user_id, is_primary) VALUES (${account_id}, ${user_id}, false)
			ON CONFLICT (account_id, user_id) DO NOTHING`;
		throw redirect(303, `${base}/administration/accounts?account=${encodeURIComponent(account_id)}`);
	},

	createAndLinkPersona: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const account_id = String(d.get('account_id') ?? '');
		const firstname = String(d.get('firstname') ?? '').trim();
		const lastname = String(d.get('lastname') ?? '').trim();
		const role_label = String(d.get('role_label') ?? '').trim() || null;
		const home_region = String(d.get('home_region') ?? 'eu-west-2').trim() || 'eu-west-2';
		const is_admin = d.get('is_admin') === 'on';
		if (!account_id || !firstname || !lastname) return fail(400, { error: 'Account, first and last name required.' });
		const user_id = await createPersona(firstname, lastname, role_label, home_region, is_admin);
		await localDb`INSERT INTO account_persona (account_id, user_id, is_primary) VALUES (${account_id}, ${user_id}, false)`;
		throw redirect(303, `${base}/administration/accounts?account=${encodeURIComponent(account_id)}`);
	},

	unlinkPersona: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const account_id = String(d.get('account_id') ?? '');
		const user_id = String(d.get('user_id') ?? '');
		// The default (primary) persona is always present and cannot be unlinked.
		const [row] = await localDb<{ is_primary: boolean }[]>`
			SELECT is_primary FROM account_persona WHERE account_id = ${account_id} AND user_id = ${user_id}`;
		if (row?.is_primary) return fail(400, { error: 'The default persona cannot be unlinked.' });
		await localDb`DELETE FROM account_persona WHERE account_id = ${account_id} AND user_id = ${user_id}`;
		throw redirect(303, `${base}/administration/accounts?account=${encodeURIComponent(account_id)}`);
	},

	makeDefault: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const account_id = String(d.get('account_id') ?? '');
		const user_id = String(d.get('user_id') ?? '');
		const [ok] = await localDb<{ ok: boolean }[]>`
			SELECT true AS ok FROM account_persona WHERE account_id = ${account_id} AND user_id = ${user_id}`;
		if (!ok) return fail(404, { error: 'Persona is not linked to this account.' });
		// Clear the old primary first (partial-unique index allows only one), then set.
		await localDb.begin(async (sql) => {
			await sql`UPDATE account_persona SET is_primary = false WHERE account_id = ${account_id} AND is_primary`;
			await sql`UPDATE account_persona SET is_primary = true  WHERE account_id = ${account_id} AND user_id = ${user_id}`;
		});
		throw redirect(303, `${base}/administration/accounts?account=${encodeURIComponent(account_id)}`);
	},

	deleteAccount: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const account_id = String(d.get('account_id') ?? '');
		if (!account_id) return fail(400, { error: 'Account required.' });
		// account_persona links cascade; the personas themselves are left intact.
		await localDb`DELETE FROM login_account WHERE account_id = ${account_id}`;
		throw redirect(303, `${base}/administration/accounts`);
	},
};
