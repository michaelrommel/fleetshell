/**
 * POST /api/cert/request
 *
 * Called by the desktop client after a successful probe. Validates the probe
 * JWT (sub === id), stores the CSR, marks cert status "pending", notifies the
 * enrollment SSE stream, then after a short simulated CA delay stores the
 * shared wildcard cert (CLIENT_CERT env) and publishes "cert-ready".
 *
 * Phase-1: the "issued" certificate is the shared *.client.fleetshell.com chain
 * from CLIENT_CERT; there is no real CA.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getRedisClient } from '$lib/server/redis';
import { verifyProbeToken } from '$lib/server/jwt';
import type { RequestHandler } from './$types';

const CERT_TTL_S = 60 * 60;
const CONSUMED_TTL_S = 5 * 60;
const SIGN_DELAY_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CERT_CHAIN: string = (() => {
	const val = (env.CLIENT_CERT ?? '').trim();
	if (val) return val;
	console.warn('[cert/request] CLIENT_CERT not set -- using placeholder');
	return ['-----BEGIN CERTIFICATE-----', '[PLACEHOLDER -- set CLIENT_CERT]', '-----END CERTIFICATE-----'].join('\n');
})();

interface CertRequestBody {
	id: string;
	csr: string;
}

export const POST: RequestHandler = async ({ request }) => {
	let body: CertRequestBody;
	try {
		body = (await request.json()) as CertRequestBody;
	} catch {
		error(400, 'Expected JSON body');
	}

	const id = String(body.id ?? '').trim();
	const csr = String(body.csr ?? '').trim();
	if (!id) error(400, 'Missing field: id');
	if (!csr) error(400, 'Missing field: csr');
	if (!UUID_RE.test(id)) error(400, 'Invalid client ID format');

	const authHeader = request.headers.get('Authorization') ?? '';
	const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
	if (!token) error(401, 'Missing Authorization: Bearer <token>');

	const secret = env.JWT_SECRET ?? 'change-me-in-production';
	const check = verifyProbeToken(token, id, secret);
	if (check === 'expired') error(401, 'Token expired');
	if (check === 'invalid') error(401, 'Invalid token');

	const redis = await getRedisClient();
	const slot = await redis.get(`client:${id}:probe`);
	if (!slot) error(404, 'No active enrollment found for this client ID');

	await Promise.all([
		redis.set(`client:${id}:cert`, 'pending', { EX: CERT_TTL_S }),
		redis.set(`client:${id}:cert:csr`, csr, { EX: CERT_TTL_S }),
	]);
	await redis.set(`client:${id}:probe:consumed`, '1', { EX: CONSUMED_TTL_S, NX: true });
	await redis.publish(`enrollment:${id}`, JSON.stringify({ event: 'csr-received', csr }));

	// Simulated CA signing delay, then store the shared cert + publish ready.
	setTimeout(async () => {
		try {
			const r = await getRedisClient();
			await Promise.all([
				r.set(`client:${id}:cert`, 'ready', { EX: CERT_TTL_S }),
				r.set(`client:${id}:cert:data`, CERT_CHAIN, { EX: CERT_TTL_S }),
			]);
			await r.publish(`enrollment:${id}`, JSON.stringify({ event: 'cert-ready' }));
		} catch (e) {
			console.error(`[cert/request/${id}] issuance error:`, String(e));
		}
	}, SIGN_DELAY_MS);

	return json({ ok: true });
};
