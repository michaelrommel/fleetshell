/**
 * Minimal HS256 JWT helper for portal probe tokens.
 *
 * Implements exactly what is needed for the probe flow:
 *   issueProbeToken(probeId, secret)  →  signed JWT string
 *   verifyProbeToken(token, probeId, secret)  →  'ok' | 'expired' | 'invalid'
 *
 * Design notes
 * ─────────────
 * • No external dependencies — Node crypto only.
 * • Timing-safe signature comparison (prevents HMAC oracle attacks).
 * • Header alg field is validated to block algorithm-confusion attacks.
 * • sub claim is cryptographically bound to the probe ID; a token cannot
 *   be reused for a different probe ID.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Encode a Buffer to base64url (URL-safe, no padding). */
function b64url(buf: Buffer): string {
	return buf.toString('base64url');
}

/** HMAC-SHA256 of `data` with `secret`, returned as a Buffer. */
function hmacSha256(data: string, secret: string): Buffer {
	return createHmac('sha256', secret).update(data).digest();
}

// Pre-compute the static header — always the same for HS256 tokens.
const HEADER_B64URL = b64url(
	Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Issue a short-lived probe token (5-minute window).
 *
 * Claims:
 *   sub  — the probe ID (cryptographically binds the token to one probe)
 *   iat  — issued-at (Unix seconds)
 *   exp  — expiry (iat + 300)
 */
export function issueProbeToken(probeId: string, secret: string): string {
	const now     = Math.floor(Date.now() / 1000);
	const payload = b64url(Buffer.from(JSON.stringify({
		sub : probeId,
		iat : now,
		exp : now + 5 * 60,
	})));

	const unsigned = `${HEADER_B64URL}.${payload}`;
	const sig      = b64url(hmacSha256(unsigned, secret));

	return `${unsigned}.${sig}`;
}

export type VerifyResult = 'ok' | 'expired' | 'invalid';

/**
 * Verify a probe token.
 *
 * Checks (in order):
 *   1. Token has three dot-separated parts.
 *   2. Header declares alg = HS256 (guards against algorithm-confusion).
 *   3. HMAC-SHA256 signature is correct (timing-safe).
 *   4. exp claim is present and not yet passed.
 *   5. sub claim matches the supplied probeId.
 */
export function verifyProbeToken(
	token   : string,
	probeId : string,
	secret  : string,
): VerifyResult {
	// 1. Structure
	const parts = token.split('.');
	if (parts.length !== 3) return 'invalid';
	const [headerB64, payloadB64, sigB64] = parts;

	// 2. Decode and check header alg
	let header: { alg?: string };
	try {
		header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
	} catch {
		return 'invalid';
	}
	if (header.alg !== 'HS256') return 'invalid';

	// 3. Timing-safe HMAC verification
	const unsigned     = `${headerB64}.${payloadB64}`;
	const expectedSig  = b64url(hmacSha256(unsigned, secret));
	try {
		const aBuf = Buffer.from(sigB64,      'base64url');
		const bBuf = Buffer.from(expectedSig, 'base64url');
		// timingSafeEqual requires equal lengths; HMAC-SHA256 is always 32 bytes,
		// so lengths will match unless the token has been tampered with.
		if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
			return 'invalid';
		}
	} catch {
		return 'invalid';
	}

	// 4 & 5. Decode payload, check exp and sub
	let claims: { sub?: string; exp?: number };
	try {
		claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
	} catch {
		return 'invalid';
	}

	if (!claims.exp || Math.floor(Date.now() / 1000) > claims.exp) {
		return 'expired';
	}

	if (claims.sub !== probeId) return 'invalid';

	return 'ok';
}
