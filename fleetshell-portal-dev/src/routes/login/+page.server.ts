import type { PageServerLoad, Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { signSession, SESSION_COOKIE, verifySession } from '$lib/server/session';
import { verifyLogin, listPersonas } from '$lib/server/identity';

function setSession(cookies: Parameters<Actions['default']>[0]['cookies'], accountId: string, userId: string | null) {
	cookies.set(SESSION_COOKIE, signSession({ accountId, userId }), {
		path: base || '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24,
	});
}

export const load: PageServerLoad = async ({ cookies }) => {
	// Already signed in? Skip straight past the form.
	const session = verifySession(cookies.get(SESSION_COOKIE));
	if (session?.userId) throw redirect(303, base || '/');
	if (session?.accountId) throw redirect(303, `${base}/select-persona`);
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data = await request.formData();
		const login = String(data.get('login') ?? '').trim();
		const password = String(data.get('password') ?? '');
		if (!login || !password) return fail(400, { error: 'Enter username and password.', login });

		const account = await verifyLogin(login, password);
		if (!account) return fail(401, { error: 'Invalid username or password.', login });

		const personas = await listPersonas(account.account_id);
		if (personas.length === 0) {
			return fail(403, { error: 'This account has no linked personas.', login });
		}
		if (personas.length === 1) {
			setSession(cookies, account.account_id, personas[0].user_id);
			throw redirect(303, base || '/');
		}
		// Multiple personas: authenticate the account, defer persona choice.
		setSession(cookies, account.account_id, null);
		throw redirect(303, `${base}/select-persona`);
	},
};
