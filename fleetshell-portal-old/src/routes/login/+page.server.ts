import { fail, redirect }  from '@sveltejs/kit';
import { env }              from '$env/dynamic/private';
import { SESSION_COOKIE }   from '$lib/server/constants.js';
import { signSession }      from '$lib/server/session.js';

import type { Actions, PageServerLoad } from './$types';

/** Redirect already-authenticated visitors straight to the welcome page. */
export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, '/welcome');
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data     = await request.formData();
		const username = (data.get('username') as string | null)?.trim() ?? '';
		const password = (data.get('password') as string | null) ?? '';

		const expectedUser = env.PORTAL_USERNAME ?? '';
		const expectedPass = env.PORTAL_PASSWORD ?? '';

		if (!expectedUser || !expectedPass) {
			console.error(
				'[portal] PORTAL_USERNAME or PORTAL_PASSWORD is not set — ' +
				'set these environment variables before starting the server.',
			);
			return fail(500, { error: 'Server is not configured. Contact the administrator.' });
		}

		// Constant-time-ish comparison: always check both fields to avoid
		// leaking which field was wrong via timing.
		const userOk = username === expectedUser;
		const passOk = password === expectedPass;

		if (!userOk || !passOk) {
			return fail(401, { error: 'Invalid username or password.' });
		}

		const secret = env.PORTAL_SESSION_SECRET ?? 'change-me-in-production';

		cookies.set(SESSION_COOKIE, signSession(username, secret), {
			path     : '/',
			httpOnly : true,
			sameSite : 'lax',
			secure   : false,          // set to true behind HTTPS in production
			maxAge   : 8 * 60 * 60,   // 8 hours
		});

		redirect(303, '/welcome');
	},
};
