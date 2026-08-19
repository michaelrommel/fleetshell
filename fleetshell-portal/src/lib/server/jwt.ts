/**
 * Minimal HS256 JWT signer for FleetShell tunnel tokens (portal-dev).
 *
 * Node crypto only -- no external dependencies. The claim format matches
 * fleetshell-gateway's auth.rs. JWT_SECRET must be identical on the portal and
 * the gateway (see AGENTS.md section 6).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

function b64url(buf: Buffer): string {
	return buf.toString('base64url');
}

function hmacSha256(data: string, secret: string): Buffer {
	return createHmac('sha256', secret).update(data).digest();
}

const HEADER_B64URL = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

/**
 * Issue a tunnel JWT that authorises a specific target/port/gateway triple.
 *
 * Claims (see gateway auth.rs Claims):
 *   sub    - authenticated persona (informational)
 *   iat    - issued-at (Unix seconds)
 *   exp    - expiry (iat + ttlSeconds, default 24 h)
 *   target - exact host the token authorises
 *   ports  - port spec string (comma/range format, same as the tunnel request)
 *   gw     - gateway identifier (optional cross-gateway replay guard)
 *   record - when true, instructs the gateway to record the session (optional)
 *   ssh_compat - when true, the gateway's direct-SSH (russh) handler also offers
 *                legacy KEX/cipher/MAC algorithms for old devices (optional)
 */
export function issueTunnelToken(
	sub: string,
	target: string,
	ports: string,
	gw: string,
	secret: string,
	ttlSeconds = 24 * 60 * 60,
	record = false,
	sshCompat = false,
): string {
	const now = Math.floor(Date.now() / 1000);
	const claims: Record<string, unknown> = {
		sub,
		iat: now,
		exp: now + ttlSeconds,
		target,
		ports,
		gw,
	};
	// Only embed optional claims when set, to keep the token compact.
	if (record) claims['record'] = true;
	if (sshCompat) claims['ssh_compat'] = true;
	const payload = b64url(Buffer.from(JSON.stringify(claims)));
	const unsigned = `${HEADER_B64URL}.${payload}`;
	const sig = b64url(hmacSha256(unsigned, secret));
	return `${unsigned}.${sig}`;
}

// ---- Probe / enrollment tokens ---------------------------------------------

/**
 * Issue a short-lived probe token bound to a probe/client ID.
 *   sub - the probe/client ID (binds the token to one enrollment)
 *   iat - issued-at (Unix seconds)
 *   exp - expiry (iat + 300)
 */
export function issueProbeToken(probeId: string, secret: string): string {
	const now = Math.floor(Date.now() / 1000);
	const payload = b64url(
		Buffer.from(JSON.stringify({ sub: probeId, iat: now, exp: now + 5 * 60 })),
	);
	const unsigned = `${HEADER_B64URL}.${payload}`;
	const sig = b64url(hmacSha256(unsigned, secret));
	return `${unsigned}.${sig}`;
}

export type VerifyResult = 'ok' | 'expired' | 'invalid';

/**
 * Verify a probe token: structure, HS256 alg, timing-safe HMAC, exp, and that
 * sub === probeId (a token issued for a different ID cannot be reused).
 */
export function verifyProbeToken(token: string, probeId: string, secret: string): VerifyResult {
	const parts = token.split('.');
	if (parts.length !== 3) return 'invalid';
	const [headerB64, payloadB64, sigB64] = parts;

	let header: { alg?: string };
	try {
		header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
	} catch {
		return 'invalid';
	}
	if (header.alg !== 'HS256') return 'invalid';

	const unsigned = `${headerB64}.${payloadB64}`;
	const expectedSig = b64url(hmacSha256(unsigned, secret));
	try {
		const a = Buffer.from(sigB64, 'base64url');
		const b = Buffer.from(expectedSig, 'base64url');
		if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid';
	} catch {
		return 'invalid';
	}

	let claims: { sub?: string; exp?: number };
	try {
		claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
	} catch {
		return 'invalid';
	}
	if (!claims.exp || Math.floor(Date.now() / 1000) > claims.exp) return 'expired';
	if (claims.sub !== probeId) return 'invalid';
	return 'ok';
}
