/**
 * POST /api/tunnel/sign
 *
 * Signs a tunnel JWT on behalf of the logged-in portal user and returns it.
 * The browser uses the token to authenticate directly to the FleetShell client
 * at https://127-0-0-1.client.fleetshell.com/api/tunnel — JWT_SECRET never
 * leaves the server.
 *
 * Requires an active portal session (session cookie).
 *
 * Request
 *   Content-Type: application/json
 *   Body: { "target": "...", "ports": "...", "gateway": "..." }
 *
 * Response 200
 *   { "token": "<jwt>" }
 */
import { error, json }        from '@sveltejs/kit';
import { env }                from '$env/dynamic/private';
import { issueTunnelToken }   from '$lib/server/jwt';
import type { RequestHandler } from './$types';

function trace(user: string, msg: string, data?: Record<string, unknown>): void {
	const line = data
		? `${new Date().toISOString()} [tunnel/sign/${user}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [tunnel/sign/${user}] ${msg}`;
	console.log(line);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const user = locals.user;
	trace(user, 'sign request received');

	let body: { target?: string; ports?: string; gateway?: string };
	try {
		body = await request.json();
	} catch {
		error(400, 'Expected JSON body');
	}

	const target  = String(body.target  ?? '').trim();
	const ports   = String(body.ports   ?? '').trim();
	const gateway = String(body.gateway ?? '').trim();

	if (!target)  error(400, 'Missing field: target');
	if (!ports)   error(400, 'Missing field: ports');
	if (!gateway) error(400, 'Missing field: gateway');

	trace(user, 'signing tunnel token', { target, ports, gateway });

	const secret = env.JWT_SECRET ?? 'change-me-in-production';
	const token  = issueTunnelToken(user, target, ports, gateway, secret);

	trace(user, 'tunnel token issued', { tokenLen: token.length });

	return json({ token });
};
