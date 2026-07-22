/**
 * POST /api/cert/request
 *
 * Called by the FleetShell desktop client after a successful probe.
 * The client submits its ID and a certificate signing request (CSR).
 *
 * Flow:
 *   1. Validate Bearer JWT — same token issued by /api/clients, sub = client ID.
 *   2. Verify the probe slot still exists (enrollment must be in progress).
 *   3. Store the CSR and mark cert status as "pending" in Redis.
 *   4. Invalidate the probe token (consumed flag) — deferred from the probe
 *      step per the enrollment design: one token covers probe + CSR submission.
 *   5. Publish a "csr-received" event so the browser SSE stream advances.
 *   6. Schedule a 10-second simulated CA signing delay, then store a
 *      placeholder certificate and publish "cert-ready".
 *
 * Request
 *   Authorization: Bearer <probe-jwt>
 *   Content-Type:  application/json
 *   Body:          { "id": "<uuid>", "csr": "<pem-or-placeholder-string>" }
 *
 * Response 200
 *   { "ok": true }
 */
import { error, json }      from '@sveltejs/kit';
import { env }              from '$env/dynamic/private';
import { getRedisClient }   from '$lib/server/redis';
import { verifyProbeToken } from '$lib/server/jwt';
import type { RequestHandler } from './$types';

// ── Constants ─────────────────────────────────────────────────────────────────

/** How long cert-related keys live in Redis. */
const CERT_TTL_S     = 60 * 60;       // 1 hour
/** How long the consumed-flag lives (covers any retry window). */
const CONSUMED_TTL_S =  5 * 60;       // 5 minutes
/** Simulated CA signing delay before cert-ready is published. */
const SIGN_DELAY_MS  = 10_000;        // 10 seconds

// ── Certificate chain ─────────────────────────────────────────────────────────
// Loaded from the CLIENT_CERT environment variable (injected via AWS Secrets
// Manager at deploy time).  Falls back to a clearly-marked placeholder so the
// server still starts cleanly in environments without the variable set.
const CERT_CHAIN: string = (() => {
	const val = (env.CLIENT_CERT ?? '').trim();
	if (val) {
		console.log(
			`${new Date().toISOString()} [cert/request] loaded cert chain from` +
			` CLIENT_CERT env var (${val.length} bytes)`,
		);
		return val;
	}
	console.warn(
		`${new Date().toISOString()} [cert/request] CLIENT_CERT not set — using placeholder`,
	);
	return [
		'-----BEGIN CERTIFICATE-----',
		'[PLACEHOLDER — set CLIENT_CERT environment variable]',
		'-----END CERTIFICATE-----',
	].join('\n');
})();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Trace helper ──────────────────────────────────────────────────────────────

function trace(id: string, msg: string, data?: Record<string, unknown>): void {
	const line = data
		? `${new Date().toISOString()} [cert/request/${id}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [cert/request/${id}] ${msg}`;
	console.log(line);
}

// ── Request body type ─────────────────────────────────────────────────────────

interface CertRequestBody {
	id  : string;
	csr : string;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const POST: RequestHandler = async ({ request }) => {

	// ── 1. Parse body ─────────────────────────────────────────────────────────
	let body: CertRequestBody;
	try {
		body = await request.json() as CertRequestBody;
	} catch (e) {
		console.error(`${new Date().toISOString()} [cert/request] JSON parse error:`, String(e));
		error(400, 'Expected JSON body');
	}

	const id  = String(body.id  ?? '').trim();
	const csr = String(body.csr ?? '').trim();

	if (!id)  error(400, 'Missing field: id');
	if (!csr) error(400, 'Missing field: csr');

	trace(id, 'request received', { csrLen: csr.length });

	// ── 2. Validate ID format ─────────────────────────────────────────────────
	if (!UUID_RE.test(id)) {
		trace(id, 'invalid ID format — rejecting');
		error(400, 'Invalid client ID format');
	}

	// ── 3. Verify Bearer JWT ──────────────────────────────────────────────────
	const authHeader = request.headers.get('Authorization') ?? '';
	const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

	if (!token) {
		trace(id, 'missing Bearer token');
		error(401, 'Missing Authorization: Bearer <token>');
	}
	trace(id, 'JWT received', { tokenLen: token.length });

	const secret = env.JWT_SECRET ?? 'change-me-in-production';
	// verifyProbeToken checks signature AND that sub === id, so a token issued
	// for a different client cannot be used here.
	const check = verifyProbeToken(token, id, secret);
	trace(id, 'JWT verification result', { check });

	if (check === 'expired') error(401, 'Token expired');
	if (check === 'invalid') error(401, 'Invalid token');

	// ── 4. Check probe slot exists ────────────────────────────────────────────
	const redis = await getRedisClient();
	const slot  = await redis.get(`client:${id}:probe`);
	trace(id, 'probe slot value', { slot: slot ?? 'null' });

	if (!slot) {
		trace(id, 'probe slot missing or expired — rejecting');
		error(404, 'No active enrollment found for this client ID');
	}

	// ── 5. Store CSR + set cert status = pending ──────────────────────────────
	await Promise.all([
		redis.set(`client:${id}:cert`,     'pending', { EX: CERT_TTL_S }),
		redis.set(`client:${id}:cert:csr`, csr,       { EX: CERT_TTL_S }),
	]);
	trace(id, 'CSR stored, cert status set to pending');

	// ── 6. Invalidate the probe token (deferred consumed flag) ────────────────
	// The probe endpoint skips setting this flag so the same short-lived JWT
	// can authenticate both the probe POST and this CSR submission.  We set it
	// now to prevent any further use of that token.
	await redis.set(
		`client:${id}:probe:consumed`, '1',
		{ EX: CONSUMED_TTL_S, NX: true },
	);
	trace(id, 'probe token marked as consumed');

	// ── 7. Notify browser SSE stream: CSR received ────────────────────────────
	const csrSubscribers = await redis.publish(
		`enrollment:${id}`,
		JSON.stringify({ event: 'csr-received', csr }),
	);
	trace(id, 'csr-received event published', { subscribers: csrSubscribers });

	// ── 8. Schedule simulated certificate issuance ────────────────────────────
	// In production this would call an ACME / internal CA API.  For now a
	// placeholder PEM string is stored after SIGN_DELAY_MS milliseconds.
	trace(id, `scheduling cert issuance in ${SIGN_DELAY_MS} ms`);

	setTimeout(async () => {
		trace(id, 'simulated CA signing delay elapsed — issuing placeholder cert');

		try {
			const redis2 = await getRedisClient();

			await Promise.all([
				redis2.set(`client:${id}:cert`,     'ready',     { EX: CERT_TTL_S }),
				redis2.set(`client:${id}:cert:data`, CERT_CHAIN, { EX: CERT_TTL_S }),
			]);
			trace(id, 'placeholder cert stored, status set to ready');

			const certSubscribers = await redis2.publish(
				`enrollment:${id}`,
				JSON.stringify({ event: 'cert-ready' }),
			);
			trace(id, 'cert-ready event published', { subscribers: certSubscribers });

		} catch (e) {
			// Log but do not crash — the browser SSE timeout will handle the stall.
			trace(id, 'ERROR during simulated cert issuance', { err: String(e) });
		}
	}, SIGN_DELAY_MS);

	return json({ ok: true });
};
