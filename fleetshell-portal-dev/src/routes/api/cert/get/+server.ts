/**
 * GET /api/cert/get?id=<client-uuid>
 *
 * Returns the issued certificate chain once status is "ready". No Bearer token
 * (same reasoning as /api/cert/status). The UUID is the discriminator and the
 * cert status must be "ready".
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
	const [status, certData] = await Promise.all([
		redis.get(`client:${id}:cert`),
		redis.get(`client:${id}:cert:data`),
	]);
	if (status !== 'ready' || !certData) error(404, 'Certificate not ready');

	return json({ cert: certData });
};
