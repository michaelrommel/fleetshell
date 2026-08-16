import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { SESSION_COOKIE } from '$lib/server/session';

export const POST: RequestHandler = ({ cookies }) => {
	cookies.delete(SESSION_COOKIE, { path: base || '/' });
	throw redirect(303, `${base}/login`);
};
