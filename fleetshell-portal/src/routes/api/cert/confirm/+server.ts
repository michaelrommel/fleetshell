/**
 * POST /api/cert/confirm
 *
 * Called by the desktop client after it has fetched + stored its certificate.
 * Marks enrollment complete (idempotent) and notifies the enrollment SSE
 * stream. No Bearer token (the probe JWT has usually expired); the UUID is the
 * discriminator and cert status must be "ready".
 */
import { error, json } from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const CONFIRMED_TTL_S = 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const POST: RequestHandler = async ({ request }) => {
	let body: { id: string };
	try {
		body = (await request.json()) as { id: string };
	} catch {
		error(400, 'Expected JSON body');
	}

	const id = String(body.id ?? '').trim();
	if (!id) error(400, 'Missing field: id');
	if (!UUID_RE.test(id)) error(400, 'Invalid client ID format');

	const redis = await getRedisClient();
	const certStatus = await redis.get(`client:${id}:cert`);
	if (certStatus !== 'ready') error(409, 'Certificate not yet issued for this client');

	const set = await redis.set(`client:${id}:enrollment:confirmed`, '1', {
		EX: CONFIRMED_TTL_S,
		NX: true,
	});
	if (set === null) return json({ ok: true }); // already confirmed (idempotent)

	await redis.publish(`enrollment:${id}`, JSON.stringify({ event: 'enrollment-confirmed' }));
	return json({ ok: true });
};
