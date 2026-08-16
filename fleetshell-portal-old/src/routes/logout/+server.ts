import { redirect }       from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/constants';
import type { RequestHandler } from './$types';

/** POST /logout — clear the session cookie and redirect to the login page. */
export const POST: RequestHandler = async ({ cookies }) => {
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/login');
};
