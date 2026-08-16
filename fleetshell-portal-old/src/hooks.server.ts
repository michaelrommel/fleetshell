import type { Handle }    from '@sveltejs/kit';
import { env }             from '$env/dynamic/private';
import { verifySession }   from '$lib/server/session';
import { SESSION_COOKIE }  from '$lib/server/constants';

export { SESSION_COOKIE };

/**
 * For every request, attempt to read and verify the session cookie and
 * populate `event.locals.user`.  All other auth decisions (redirects) are
 * made inside individual route `load` functions and form actions.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const secret = env.PORTAL_SESSION_SECRET ?? 'change-me-in-production';
	const raw    = event.cookies.get(SESSION_COOKIE);

	event.locals.user = raw ? verifySession(raw, secret) : null;

	return resolve(event);
};
