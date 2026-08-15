/**
 * GET /api/cert/key?id=<client-uuid>
 *
 * Returns the shared wildcard private key (CLIENT_KEY env) once cert status is
 * "ready". No Bearer token (the probe JWT has usually expired by now); the UUID
 * is the discriminator and status must be "ready".
 *
 * Phase-1: the same *.client.fleetshell.com private key is returned to every
 * enrolled client. Phase-2 will move to per-client key pairs.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRIVATE_KEY: string = (() => {
	const val = (env.CLIENT_KEY ?? '').trim();
	if (val) return val;
	console.warn('[cert/key] CLIENT_KEY not set -- using placeholder');
	return ['-----BEGIN PRIVATE KEY-----', '[PLACEHOLDER -- set CLIENT_KEY]', '-----END PRIVATE KEY-----'].join('\n');
})();

export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id')?.trim() ?? '';
	if (!id) error(400, 'Missing query parameter: id');
	if (!UUID_RE.test(id)) error(400, 'Invalid client ID format');

	const redis = await getRedisClient();
	const status = await redis.get(`client:${id}:cert`);
	if (status !== 'ready') error(404, 'Certificate not ready');

	return json({ key: PRIVATE_KEY });
};
