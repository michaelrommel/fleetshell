// src/lib/server/session.ts
//
// Signed session for the dev login. Carries TWO ids (see docs/portal_ui.md):
//   accountId  the human who authenticated (login_account)
//   userId     the active persona (app_user) they are working as, or null when
//              the account has >1 linked persona and has not chosen yet.
//
// Payload is base64url(JSON) with an HMAC so it can't be forged. Callers read
// locals.userId (active persona) exactly as before; the account layer is
// additive. Swap verifyLogin (identity.ts) for SAML/OAuth without touching this.

import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';

const SECRET = env.SESSION_SECRET ?? 'dev-session-secret-change-me';
export const SESSION_COOKIE = 'session';

export interface SessionData {
	accountId: string;
	userId: string | null;
}

function mac(value: string): string {
	return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

export function signSession(data: SessionData): string {
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	return `${payload}.${mac(payload)}`;
}

export function verifySession(cookie: string | undefined): SessionData | null {
	if (!cookie) return null;
	const dot = cookie.lastIndexOf('.');
	if (dot < 0) return null;
	const payload = cookie.slice(0, dot);
	const sig = cookie.slice(dot + 1);
	const expected = mac(payload);
	if (sig.length !== expected.length) return null;
	if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
	try {
		const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		if (typeof data?.accountId !== 'string') return null;
		const userId = typeof data.userId === 'string' ? data.userId : null;
		return { accountId: data.accountId, userId };
	} catch {
		return null;
	}
}
