import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { base } from '$app/paths';
import { env } from '$env/dynamic/private';
import { isTheme } from '$lib/theme';
import { persistUserTheme } from '$lib/server/theme';

// POST /theme?value=nucleus|gruvbox
// Sets the cookie (instant SSR next load) and persists to the user's DB pref.
export const POST: RequestHandler = async ({ url, cookies, locals }) => {
	const value = url.searchParams.get('value');
	if (!isTheme(value)) throw error(400, 'invalid theme');

	cookies.set('theme', value, {
		path: base || '/',
		httpOnly: false,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 365,
	});

	const userId = locals.userId ?? env.DEV_USER_ID;
	if (userId) await persistUserTheme(userId, value);

	return json({ ok: true, theme: value });
};
