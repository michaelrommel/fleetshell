/**
 * Minimal HS256 JWT signer for FleetShell tunnel tokens (portal-dev).
 *
 * Node crypto only -- no external dependencies. The claim format matches
 * fleetshell-gateway's auth.rs. JWT_SECRET must be identical on the portal and
 * the gateway (see AGENTS.md section 6).
 */
import { createHmac } from 'node:crypto';

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
 */
export function issueTunnelToken(
	sub: string,
	target: string,
	ports: string,
	gw: string,
	secret: string,
	ttlSeconds = 24 * 60 * 60,
	record = false,
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
	// Only embed 'record' when true, to keep the token compact.
	if (record) claims['record'] = true;
	const payload = b64url(Buffer.from(JSON.stringify(claims)));
	const unsigned = `${HEADER_B64URL}.${payload}`;
	const sig = b64url(hmacSha256(unsigned, secret));
	return `${unsigned}.${sig}`;
}
