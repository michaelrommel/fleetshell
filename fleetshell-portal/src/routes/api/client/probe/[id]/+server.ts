/**
 * POST /api/client/probe/[id]
 *
 * Called by the FleetShell desktop client.  Verifies the JWT, prevents
 * replay, stores version/arch, and publishes to the SSE stream via Redis.
 */
import { error, json }       from '@sveltejs/kit';
import { env }               from '$env/dynamic/private';
import { getRedisClient }    from '$lib/server/redis';
import { verifyProbeToken }  from '$lib/server/jwt';
import type { RequestHandler } from './$types';

const PROBE_TTL_S    = 30 * 60;
const CONSUMED_TTL_S =  5 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trace(id: string, msg: string, data?: Record<string, unknown>) {
	const line = data
		? `${new Date().toISOString()} [probe-post/${id}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [probe-post/${id}] ${msg}`;
	console.log(line);
}

interface ProbeBody { version: string; arch: string; }

export const POST: RequestHandler = async ({ params, request }) => {
	const { id } = params;
	trace(id, 'request received');

	// ── ID format ─────────────────────────────────────────────────────────────
	if (!UUID_RE.test(id)) {
		trace(id, 'invalid ID format — rejecting');
		error(400, 'Invalid probe ID');
	}

	// ── JWT verification ──────────────────────────────────────────────────────
	const authHeader = request.headers.get('Authorization') ?? '';
	const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

	if (!token) {
		trace(id, 'missing Bearer token');
		error(401, 'Missing Authorization: Bearer <token>');
	}
	trace(id, 'JWT received', { tokenLen: token.length });

	const secret = env.JWT_SECRET ?? 'change-me-in-production';
	const check  = verifyProbeToken(token, id, secret);
	trace(id, 'JWT verification result', { check });

	if (check === 'expired') error(401, 'Probe token expired');
	if (check === 'invalid') error(401, 'Invalid probe token');

	// ── Replay prevention ─────────────────────────────────────────────────────
	trace(id, 'checking replay prevention key');
	const redis    = await getRedisClient();
	const consumed = await redis.set(
		`client:${id}:probe:consumed`, '1',
		{ EX: CONSUMED_TTL_S, NX: true },
	);
	trace(id, 'replay check', { alreadyConsumed: consumed === null });
	if (consumed === null) error(409, 'Probe token already used');

	// ── Probe slot ────────────────────────────────────────────────────────────
	const slot = await redis.get(`client:${id}:probe`);
	trace(id, 'probe slot value', { slot: slot ?? 'null' });
	if (!slot) error(404, 'Probe not found or expired');

	// ── Body ──────────────────────────────────────────────────────────────────
	let body: ProbeBody;
	try {
		body = await request.json() as ProbeBody;
	} catch (e) {
		trace(id, 'JSON parse error', { err: String(e) });
		error(400, 'Expected JSON body');
	}
	trace(id, 'body parsed', { version: body.version, arch: body.arch });

	const result: ProbeBody = {
		version : String(body.version ?? 'unknown'),
		arch    : String(body.arch    ?? 'unknown'),
	};

	// ── Persist + publish ─────────────────────────────────────────────────────
	await redis.set(`client:${id}:probe`, JSON.stringify(result), { EX: PROBE_TTL_S });
	trace(id, 'result stored in Redis');

	const subscribers = await redis.publish(`probe:${id}`, JSON.stringify(result));
	trace(id, 'published to Redis channel', { subscriberCount: subscribers });

	return json({ ok: true });
};
