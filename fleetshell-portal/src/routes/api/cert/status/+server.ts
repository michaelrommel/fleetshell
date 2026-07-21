/**
 * GET /api/cert/status?id=<client-uuid>
 *
 * Called by the FleetShell desktop client to poll for its certificate
 * issuance status.  The client should call this repeatedly (with a short
 * interval, e.g. 2–5 s) after submitting a CSR to /api/cert/request,
 * until the returned status is "ready", then fetch the cert from
 * /api/cert/get?id=<id>.
 *
 * No Bearer token is required: the UUID is the discriminator and the
 * value returned (a single status string) is non-sensitive.  A short-lived
 * JWT would cause problems here because the probe token may well have
 * expired by the time the simulated CA signing delay finishes.
 *
 * Query parameter
 *   id   required   The client's stable UUID (set during enrollment).
 *
 * Response 200
 *   { "status": "none" }     — no cert request on record for this ID
 *   { "status": "pending" }  — CSR received, certificate not yet issued
 *   { "status": "ready" }    — certificate is ready to fetch
 */
import { error, json }    from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trace(id: string, msg: string, data?: Record<string, unknown>): void {
	const line = data
		? `${new Date().toISOString()} [cert/status/${id}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [cert/status/${id}] ${msg}`;
	console.log(line);
}

export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id')?.trim() ?? '';

	if (!id) error(400, 'Missing query parameter: id');

	if (!UUID_RE.test(id)) {
		error(400, 'Invalid client ID format');
	}

	trace(id, 'status requested');

	const redis  = await getRedisClient();
	const status = await redis.get(`client:${id}:cert`);

	// Redis returns null when the key does not exist.
	const result = (status === 'pending' || status === 'ready') ? status : 'none';

	trace(id, 'status response', { redisValue: status ?? 'null', result });

	return json({ status: result });
};
