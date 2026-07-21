/**
 * Stateless signed-cookie session helpers.
 *
 * Cookie format:  <base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>
 *
 * The secret is passed explicitly so this module has no side-effects at
 * import time and works correctly regardless of module load order.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionPayload {
	user : string;
	iat  : number;   // Unix ms — issued-at, used for future expiry checks
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Sign a session payload and return the cookie value string.
 * The returned string is safe to store in an HttpOnly cookie.
 */
export function signSession(username: string, secret: string): string {
	const payload = Buffer
		.from(JSON.stringify({ user: username, iat: Date.now() } satisfies SessionPayload))
		.toString('base64url');
	const sig = hmac(payload, secret);
	return `${payload}.${sig}`;
}

/**
 * Verify a cookie value and return the username it encodes, or `null` if
 * the cookie is missing, malformed, or the signature does not match.
 *
 * Uses a timing-safe comparison to prevent HMAC oracle attacks.
 */
export function verifySession(cookie: string, secret: string): string | null {
	const dot = cookie.lastIndexOf('.');
	if (dot < 0) return null;

	const payload  = cookie.slice(0, dot);
	const received = cookie.slice(dot + 1);
	const expected = hmac(payload, secret);

	// Timing-safe comparison — Buffer lengths must match first.
	const rBuf = Buffer.from(received, 'base64url');
	const eBuf = Buffer.from(expected, 'base64url');
	if (rBuf.length !== eBuf.length) return null;
	if (!timingSafeEqual(rBuf, eBuf)) return null;

	try {
		const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionPayload;
		return typeof data.user === 'string' ? data.user : null;
	} catch {
		return null;
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hmac(data: string, secret: string): string {
	return createHmac('sha256', secret).update(data).digest('base64url');
}
