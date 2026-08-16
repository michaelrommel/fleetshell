/**
 * POST /api/tunnel/sign
 *
 * Signs a tunnel JWT on behalf of the active persona and returns it, together
 * with the device's connection target + gateway (both resolved server-side from
 * the device record, never taken from the browser). The browser uses the token
 * to authenticate directly to the local FleetShell client; JWT_SECRET never
 * leaves the server.
 *
 * Authorization (MDM model, see docs/mdm_design.md): the active persona must
 * hold `device:connect` on the device via its grants -- OR be an interim admin.
 * This is server-authoritative; the UI hint is not trusted.
 *
 * Request  { deviceId: string, ports: string, record?: boolean }
 * Response { token: string, target: string, gateway: string }
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { resolveGroupIds, can } from '$lib/server/authz';
import { issueTunnelToken } from '$lib/server/jwt';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.userId) error(401, 'Unauthorized');

	let body: { deviceId?: string; ports?: string; record?: boolean };
	try {
		body = await request.json();
	} catch {
		error(400, 'Expected JSON body');
	}

	const deviceId = String(body.deviceId ?? '').trim();
	const ports = String(body.ports ?? '').trim();
	const record = body.record === true;
	if (!deviceId) error(400, 'Missing field: deviceId');
	if (!ports) error(400, 'Missing field: ports');

	// Authorization: interim admin OR device:connect via the persona's grants.
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;
	if (!isAdmin) {
		const groupIds = await resolveGroupIds(locals.userId);
		const allowed = await can(groupIds, 'connect', deviceId);
		if (!allowed) error(403, 'Not authorized to connect to this device');
	}

	// Resolve target + tunnel gateway. The tunnel ALWAYS addresses the device's
	// global IP (d.ip_address); the gateway/ipsecnode NATs it to the device's real
	// IP (platform NAT) or passes it through (customer NAT). ip_real is NOT the
	// tunnel target -- it is informational only. The JWT `gw` claim is the regional
	// fleetshell-gateway address on the device's IPsec gateway (gateway.tunnel_gateway).
	const [dev] = await globalDb<{ target: string | null; gateway: string | null }[]>`
		SELECT NULLIF(d.ip_address, '')      AS target,
		       NULLIF(gw.tunnel_gateway, '') AS gateway
		FROM device d
		LEFT JOIN gateway gw ON gw.id = d.gateway_id
		WHERE d.id = ${deviceId}`;
	if (!dev) error(404, 'Device not found');
	if (!dev.target) error(409, 'Device has no (global) IP address configured');
	if (!dev.gateway) error(409, 'Device has no tunnel gateway configured (set it on its IPsec gateway)');

	const secret = env.JWT_SECRET ?? 'change-me-in-production';
	const token = issueTunnelToken(locals.userId, dev.target, ports, dev.gateway, secret, undefined, record);

	return json({ token, target: dev.target, gateway: dev.gateway });
};
