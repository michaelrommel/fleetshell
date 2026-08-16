/**
 * POST /api/client/probe/[id]
 *
 * Called by the FleetShell desktop client. Verifies the probe JWT, prevents
 * replay, stores version/arch, and publishes to the probe SSE stream via Redis
 * pub/sub. Not session-guarded: the client authenticates with the Bearer JWT.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getRedisClient } from '$lib/server/redis';
import { verifyProbeToken } from '$lib/server/jwt';
import type { RequestHandler } from './$types';

const PROBE_TTL_S = 30 * 60;
const CONSUMED_TTL_S = 5 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ProbeBody {
	version: string;
	arch: string;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const { id } = params;
	if (!UUID_RE.test(id)) error(400, 'Invalid probe ID');

	const authHeader = request.headers.get('Authorization') ?? '';
	const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
	if (!token) error(401, 'Missing Authorization: Bearer <token>');

	const secret = env.JWT_SECRET ?? 'change-me-in-production';
	const check = verifyProbeToken(token, id, secret);
	if (check === 'expired') error(401, 'Probe token expired');
	if (check === 'invalid') error(401, 'Invalid probe token');

	const redis = await getRedisClient();

	// Replay prevention -- note /api/cert/request also sets this flag, so one
	// short-lived JWT covers probe + CSR submission. If already consumed here,
	// the token was reused: reject.
	const consumed = await redis.set(`client:${id}:probe:consumed`, '1', {
		EX: CONSUMED_TTL_S,
		NX: true,
	});
	if (consumed === null) error(409, 'Probe token already used');

	const slot = await redis.get(`client:${id}:probe`);
	if (!slot) error(404, 'Probe not found or expired');

	let body: ProbeBody;
	try {
		body = (await request.json()) as ProbeBody;
	} catch {
		error(400, 'Expected JSON body');
	}

	const result: ProbeBody = {
		version: String(body.version ?? 'unknown'),
		arch: String(body.arch ?? 'unknown'),
	};

	await redis.set(`client:${id}:probe`, JSON.stringify(result), { EX: PROBE_TTL_S });
	await redis.publish(`probe:${id}`, JSON.stringify(result));

	return json({ ok: true });
};
