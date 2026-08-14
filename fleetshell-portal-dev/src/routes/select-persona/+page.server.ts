import type { PageServerLoad, Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { listPersonas, accountCanAssume, getAccount } from '$lib/server/identity';

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!locals.accountId) throw redirect(303, `${base}/login`);

	const personas = await listPersonas(locals.accountId);

	// Nothing to choose: one persona -> assume it; none -> back to login.
	if (personas.length === 1) {
		cookies.set(SESSION_COOKIE, signSession({ accountId: locals.accountId, userId: personas[0].user_id }), {
			path: base || '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24,
		});
		throw redirect(303, base || '/');
	}
	if (personas.length === 0) throw redirect(303, `${base}/login`);

	const account = await getAccount(locals.accountId);
	return { account, personas, currentUserId: locals.userId ?? null };
};

export const actions: Actions = {
	default: async ({ request, locals, cookies }) => {
		if (!locals.accountId) throw redirect(303, `${base}/login`);
		const data = await request.formData();
		const userId = String(data.get('user_id') ?? '');
		if (!userId) return fail(400, { error: 'No persona selected.' });
		if (!(await accountCanAssume(locals.accountId, userId))) {
			return fail(403, { error: 'That persona is not linked to your account.' });
		}
		cookies.set(SESSION_COOKIE, signSession({ accountId: locals.accountId, userId }), {
			path: base || '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24,
		});
		throw redirect(303, base || '/');
	},
};
