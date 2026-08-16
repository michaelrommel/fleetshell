/**
 * GET /api/cert/status?id=<client-uuid>
 *
 * Polled by the desktop client after submitting a CSR. Returns none | pending |
 * ready. No Bearer token: the probe JWT may have expired by now; the UUID is the
 * discriminator and the value is non-sensitive.
 */
import { error, json } from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id')?.trim() ?? '';
	if (!id) error(400, 'Missing query parameter: id');
	if (!UUID_RE.test(id)) error(400, 'Invalid client ID format');

	const redis = await getRedisClient();
	const status = await redis.get(`client:${id}:cert`);
	const result = status === 'pending' || status === 'ready' ? status : 'none';
	return json({ status: result });
};
