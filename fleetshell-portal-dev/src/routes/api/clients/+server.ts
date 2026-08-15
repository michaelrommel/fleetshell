/**
 * POST /api/clients
 *
 * Returns the stable probe client-ID for the current login account, creating
 * one on first call. Resets the probe slot + enrollment state, issues a
 * short-lived JWT, and returns both so the browser can open an SSE stream and
 * trigger the desktop client.
 *
 * Keyed on the login ACCOUNT (the human), not the active persona -- enrollment
 * is per-person.
 */
import { error, json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getRedisClient } from '$lib/server/redis';
import { issueProbeToken } from '$lib/server/jwt';
import type { RequestHandler } from './$types';

const PROBE_TTL_S = 30 * 60;

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.accountId) error(401, 'Unauthorized');
	const acct = locals.accountId;

	const redis = await getRedisClient();

	// Retrieve or lazily create the stable client ID for this account.
	let id = await redis.get(`association:${acct}`);
	if (!id) {
		id = randomUUID();
		await redis.set(`association:${acct}`, id);
	}

	// Reset the probe slot AND clear all enrollment state from any previous
	// session for this ID -- otherwise the enrollment SSE fast-path replay would
	// see a stale `enrollment:confirmed` flag and jump straight to "enrolled".
	await Promise.all([
		redis.set(`client:${id}:probe`, 'pending', { EX: PROBE_TTL_S }),
		redis.del(`client:${id}:probe:consumed`),
		redis.del(`client:${id}:cert`),
		redis.del(`client:${id}:cert:csr`),
		redis.del(`client:${id}:cert:data`),
		redis.del(`client:${id}:enrollment:confirmed`),
	]);

	const secret = env.JWT_SECRET ?? 'change-me-in-production';
	const token = issueProbeToken(id, secret);

	return json({ id, token });
};
