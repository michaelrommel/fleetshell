// src/lib/server/theme.ts
//
// Resolution order: cookie (explicit, fast, no DB) -> user DB pref -> admin
// org default (global app_setting) -> DEFAULT_THEME. DB lookups are wrapped so
// a DB hiccup never blocks page render.

import type { RequestEvent } from '@sveltejs/kit';
import { DEFAULT_THEME, isTheme, type Theme } from '$lib/theme';
import { env } from '$env/dynamic/private';
import { globalDb, localDb } from './db';

let adminCache: { value: Theme; at: number } | null = null;
const ADMIN_TTL_MS = 60_000;

async function adminDefault(): Promise<Theme> {
	if (adminCache && Date.now() - adminCache.at < ADMIN_TTL_MS) return adminCache.value;
	try {
		const [row] = await globalDb<{ value: string }[]>`
			SELECT value FROM app_setting WHERE key = 'default_theme'
		`;
		const value = isTheme(row?.value) ? row.value : DEFAULT_THEME;
		adminCache = { value, at: Date.now() };
		return value;
	} catch {
		return DEFAULT_THEME;
	}
}

async function userPref(userId: string): Promise<Theme | null> {
	try {
		const [row] = await localDb<{ theme: string | null }[]>`
			SELECT theme FROM app_user WHERE user_id = ${userId}
		`;
		return isTheme(row?.theme) ? row.theme : null;
	} catch {
		return null;
	}
}

export async function resolveTheme(event: RequestEvent): Promise<Theme> {
	const cookie = event.cookies.get('theme');
	if (isTheme(cookie)) return cookie;

	// Until real auth lands, the "current user" is DEV_USER_ID.
	const userId = event.locals.userId ?? env.DEV_USER_ID;
	if (userId) {
		const pref = await userPref(userId);
		if (pref) return pref;
	}
	return adminDefault();
}

export async function persistUserTheme(userId: string, theme: Theme): Promise<void> {
	try {
		await localDb`UPDATE app_user SET theme = ${theme}, updated_at = now() WHERE user_id = ${userId}`;
	} catch {
		// best-effort; cookie already carries the choice
	}
}
