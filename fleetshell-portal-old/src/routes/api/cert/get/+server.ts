/**
 * GET /api/cert/get?id=<client-uuid>
 *
 * Called by the FleetShell desktop client once /api/cert/status returns
 * "ready".  Returns the issued certificate (placeholder PEM for now).
 *
 * No Bearer token required — same reasoning as /api/cert/status: the probe
 * JWT may have expired by this point, and the UUID is the discriminator.
 *
 * Query parameter
 *   id   required   The client's stable UUID.
 *
 * Response 200
 *   { "cert": "<pem-string>" }
 *
 * Response 404
 *   Certificate not yet issued or ID unknown.
 */
import { error, json }    from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trace(id: string, msg: string, data?: Record<string, unknown>): void {
	const line = data
		? `${new Date().toISOString()} [cert/get/${id}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [cert/get/${id}] ${msg}`;
	console.log(line);
}

export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id')?.trim() ?? '';

	if (!id) error(400, 'Missing query parameter: id');

	if (!UUID_RE.test(id)) {
		error(400, 'Invalid client ID format');
	}

	trace(id, 'cert fetch requested');

	const redis = await getRedisClient();

	const [status, certData] = await Promise.all([
		redis.get(`client:${id}:cert`),
		redis.get(`client:${id}:cert:data`),
	]);

	trace(id, 'Redis lookup result', {
		status   : status   ?? 'null',
		hasCert  : !!certData,
	});

	if (status !== 'ready' || !certData) {
		trace(id, 'cert not ready — returning 404');
		error(404, 'Certificate not ready');
	}

	trace(id, 'returning cert', { certLen: certData.length });

	return json({ cert: certData });
};
