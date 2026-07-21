/**
 * POST /api/clients
 *
 * Returns the stable probe client-ID for the currently logged-in user,
 * creating one on first call.  Resets the probe slot, issues a short-lived
 * JWT, and returns both so the browser can open an SSE stream and trigger
 * the desktop client.
 */
import { error, json }       from '@sveltejs/kit';
import { randomUUID }        from 'node:crypto';
import { env }               from '$env/dynamic/private';
import { getRedisClient }    from '$lib/server/redis';
import { issueProbeToken }   from '$lib/server/jwt';
import type { RequestHandler } from './$types';

const PROBE_TTL_S = 30 * 60;

function trace(user: string, msg: string, data?: Record<string, unknown>) {
	const line = data
		? `${new Date().toISOString()} [api/clients/${user}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [api/clients/${user}] ${msg}`;
	console.log(line);
}

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const user  = locals.user;
	trace(user, 'request received');

	const redis = await getRedisClient();

	// Retrieve or lazily create the stable client ID for this user.
	let id = await redis.get(`association:${user}`);
	if (!id) {
		id = randomUUID();
		await redis.set(`association:${user}`, id);
		trace(user, 'new client ID created', { id });
	} else {
		trace(user, 'existing client ID retrieved', { id });
	}

	// Reset the probe slot; clear any previous consumed marker.
	await Promise.all([
		redis.set(`client:${id}:probe`, 'pending', { EX: PROBE_TTL_S }),
		redis.del(`client:${id}:probe:consumed`),
	]);
	trace(user, 'probe slot reset to pending', { id });

	// Issue a 5-minute JWT bound to this probe ID.
	const secret = env.JWT_SECRET ?? 'change-me-in-production';
	const token  = issueProbeToken(id, secret);
	trace(user, 'probe token issued', { id, tokenLen: token.length });

	return json({ id, token });
};
