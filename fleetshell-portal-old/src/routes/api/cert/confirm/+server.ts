/**
 * POST /api/cert/confirm
 *
 * Called by the FleetShell desktop client after it has successfully
 * fetched and stored its certificate from /api/cert/get.
 * Marks the enrollment as complete and notifies the browser SSE stream.
 *
 * No Bearer token required: the probe JWT will typically have expired by
 * the time the client reaches this step (issued at probe time, 5-min TTL;
 * CSR submission + 10 s CA delay + polling pushes beyond that window).
 * The UUID is the discriminator; the confirmed flag is idempotent (NX).
 *
 * Request
 *   Content-Type: application/json
 *   Body:         { "id": "<client-uuid>" }
 *
 * Response 200
 *   { "ok": true }
 *
 * Response 409
 *   Enrollment already confirmed (idempotent guard).
 */
import { error, json }    from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const CONFIRMED_TTL_S = 24 * 60 * 60;   // 24 hours

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trace(id: string, msg: string, data?: Record<string, unknown>): void {
	const line = data
		? `${new Date().toISOString()} [cert/confirm/${id}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [cert/confirm/${id}] ${msg}`;
	console.log(line);
}

export const POST: RequestHandler = async ({ request }) => {
	let body: { id: string };
	try {
		body = await request.json() as { id: string };
	} catch (e) {
		console.error(`${new Date().toISOString()} [cert/confirm] JSON parse error:`, String(e));
		error(400, 'Expected JSON body');
	}

	const id = String(body.id ?? '').trim();

	if (!id) error(400, 'Missing field: id');

	if (!UUID_RE.test(id)) {
		error(400, 'Invalid client ID format');
	}

	trace(id, 'confirmation received');

	const redis = await getRedisClient();

	// ── Guard: certificate must be ready before confirming ────────────────────
	const certStatus = await redis.get(`client:${id}:cert`);
	trace(id, 'cert status check', { certStatus: certStatus ?? 'null' });

	if (certStatus !== 'ready') {
		trace(id, 'cert not ready — rejecting confirmation');
		error(409, 'Certificate not yet issued for this client');
	}

	// ── Idempotent confirmed flag (NX — set only if not already set) ──────────
	const set = await redis.set(
		`client:${id}:enrollment:confirmed`, '1',
		{ EX: CONFIRMED_TTL_S, NX: true },
	);

	if (set === null) {
		// Already confirmed — return success anyway (idempotent).
		trace(id, 'already confirmed — returning ok (idempotent)');
		return json({ ok: true });
	}

	trace(id, 'enrollment confirmed stored in Redis');

	// ── Notify browser SSE stream ─────────────────────────────────────────────
	const subscribers = await redis.publish(
		`enrollment:${id}`,
		JSON.stringify({ event: 'enrollment-confirmed' }),
	);
	trace(id, 'enrollment-confirmed event published', { subscribers });

	return json({ ok: true });
};
