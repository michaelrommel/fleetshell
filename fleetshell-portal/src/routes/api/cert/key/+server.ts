/**
 * GET /api/cert/key?id=<client-uuid>
 *
 * Called by the FleetShell desktop client once /api/cert/status returns
 * "ready" and the certificate has been fetched from /api/cert/get.
 * Returns the private key that corresponds to the shared wildcard
 * certificate served by this portal.
 *
 * Security model
 *   No Bearer token is required at this step — the probe JWT will typically
 *   have expired by the time the client reaches here (issued at probe time,
 *   5-min TTL; CSR submission + CA signing delay + polling push beyond that
 *   window).  The UUID is the discriminator; the cert status must be "ready"
 *   so only a client that has successfully completed the cert-request/status
 *   cycle can retrieve the key.
 *
 * Note — Phase 1 shared key
 *   The same wildcard private key (*.client.fleetshell.com) is returned to
 *   every enrolled client.  In Phase 2 each client will generate its own
 *   key pair and submit a real CSR; this endpoint will then return a
 *   per-client key or be removed entirely.
 *
 * Query parameter
 *   id   required   The client's stable UUID.
 *
 * Response 200
 *   { "key": "<pem-string>" }
 *
 * Response 404
 *   Certificate not yet issued or ID unknown — key will not be provided
 *   until enrollment has reached the "ready" state.
 */
import { readFileSync }   from 'node:fs';
import { join }           from 'node:path';
import { error, json }    from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

// ── Private key ───────────────────────────────────────────────────────────────
// Read once at module load time.  Falls back to a clearly-marked placeholder
// if the file is absent so the server still starts cleanly in dev environments
// without the key file present.
let PRIVATE_KEY: string;
try {
	PRIVATE_KEY = readFileSync(join(process.cwd(), 'private/client.key'), 'utf8').trim();
	console.log(
		`${new Date().toISOString()} [cert/key] loaded private key from` +
		` private/client.key (${PRIVATE_KEY.length} bytes)`,
	);
} catch {
	console.warn(
		`${new Date().toISOString()} [cert/key] private/client.key not found — using placeholder`,
	);
	PRIVATE_KEY = [
		'-----BEGIN PRIVATE KEY-----',
		'[PLACEHOLDER — place real key at private/client.key]',
		'-----END PRIVATE KEY-----',
	].join('\n');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Trace helper ──────────────────────────────────────────────────────────────

function trace(id: string, msg: string, data?: Record<string, unknown>): void {
	const line = data
		? `${new Date().toISOString()} [cert/key/${id}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [cert/key/${id}] ${msg}`;
	console.log(line);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id')?.trim() ?? '';

	if (!id) error(400, 'Missing query parameter: id');

	if (!UUID_RE.test(id)) {
		error(400, 'Invalid client ID format');
	}

	trace(id, 'private key requested');

	const redis = await getRedisClient();
	const status = await redis.get(`client:${id}:cert`);

	trace(id, 'cert status check', { status: status ?? 'null' });

	if (status !== 'ready') {
		trace(id, 'cert not ready — refusing to serve key');
		error(404, 'Certificate not ready');
	}

	trace(id, 'returning private key');

	return json({ key: PRIVATE_KEY });
};
