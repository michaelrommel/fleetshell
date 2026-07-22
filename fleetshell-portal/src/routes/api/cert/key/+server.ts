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
import { error, json }    from '@sveltejs/kit';
import { env }            from '$env/dynamic/private';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

// ── Private key ───────────────────────────────────────────────────────────────
// Loaded from the CLIENT_KEY environment variable (injected via AWS Secrets
// Manager at deploy time).  Falls back to a clearly-marked placeholder so the
// server still starts cleanly in environments without the variable set.
const PRIVATE_KEY: string = (() => {
	const val = (env.CLIENT_KEY ?? '').trim();
	if (val) {
		console.log(
			`${new Date().toISOString()} [cert/key] loaded private key from` +
			` CLIENT_KEY env var (${val.length} bytes)`,
		);
		return val;
	}
	console.warn(
		`${new Date().toISOString()} [cert/key] CLIENT_KEY not set — using placeholder`,
	);
	return [
		'-----BEGIN PRIVATE KEY-----',
		'[PLACEHOLDER — set CLIENT_KEY environment variable]',
		'-----END PRIVATE KEY-----',
	].join('\n');
})();

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
