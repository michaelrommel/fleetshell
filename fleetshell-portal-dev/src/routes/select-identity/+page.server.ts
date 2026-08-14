import type { PageServerLoad, Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { listIdentities, accountCanAssume, getAccount } from '$lib/server/identity';

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!locals.accountId) throw redirect(303, `${base}/login`);

	const identities = await listIdentities(locals.accountId);

	// Nothing to choose: one identity -> assume it; none -> back to login.
	if (identities.length === 1) {
		cookies.set(SESSION_COOKIE, signSession({ accountId: locals.accountId, userId: identities[0].user_id }), {
			path: base || '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24,
		});
		throw redirect(303, base || '/');
	}
	if (identities.length === 0) throw redirect(303, `${base}/login`);

	const account = await getAccount(locals.accountId);
	return { account, identities, currentUserId: locals.userId ?? null };
};

export const actions: Actions = {
	default: async ({ request, locals, cookies }) => {
		if (!locals.accountId) throw redirect(303, `${base}/login`);
		const data = await request.formData();
		const userId = String(data.get('user_id') ?? '');
		if (!userId) return fail(400, { error: 'No identity selected.' });
		if (!(await accountCanAssume(locals.accountId, userId))) {
			return fail(403, { error: 'That identity is not linked to your account.' });
		}
		cookies.set(SESSION_COOKIE, signSession({ accountId: locals.accountId, userId }), {
			path: base || '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24,
		});
		throw redirect(303, base || '/');
	},
};
