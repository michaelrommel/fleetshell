import type { Handle } from '@sveltejs/kit';
import { resolveTheme } from '$lib/server/theme';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';

export const handle: Handle = async ({ event, resolve }) => {
	const session = verifySession(event.cookies.get(SESSION_COOKIE));
	if (session) {
		event.locals.accountId = session.accountId;
		if (session.userId) event.locals.userId = session.userId;
	}

	const theme = await resolveTheme(event);
	event.locals.theme = theme;

	return resolve(event, {
		// Inject data-theme SSR so there is no flash of the wrong theme.
		transformPageChunk: ({ html }) => html.replace('%theme%', theme),
	});
};
