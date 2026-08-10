/**
 * GET  /api/devices/<ip>   -- load full device detail (aeroftp fields + config).
 * PUT  /api/devices/<ip>   -- upsert the app_config for this device.
 *
 * Only the app_config field is written; the aeroftp scalar fields are never
 * touched here.  Editing those is a separate, future step.
 *
 * PUT body:
 *   {
 *     config: DeviceConfig,   // { target, gateway, servicekey, apps[] }
 *     create?: boolean        // when true, refuse to overwrite an existing device
 *   }
 */
import { json, error }        from '@sveltejs/kit';
import {
	loadDevice,
	saveDeviceConfig,
	deviceExists,
	parseConfig,
}                             from '$lib/server/devices';
import type { RequestHandler } from './$types';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIpv4(ip: string): boolean {
	const m = IPV4_RE.exec(ip);
	if (!m) return false;
	return m.slice(1).every(o => Number(o) <= 255);
}

// ── GET ──────────────────────────────────────────────────────────────────────

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	const ip = params.ip ?? '';
	if (!isValidIpv4(ip)) error(400, 'Invalid device IP');
	const device = await loadDevice(ip);
	return json({ device });
};

// ── PUT (upsert app_config) ──────────────────────────────────────────────────

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const ip = params.ip ?? '';
	if (!isValidIpv4(ip)) error(400, 'Invalid device IP');

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') error(400, 'Invalid JSON body');

	const create = body.create === true;
	const exists = await deviceExists(ip);
	if (create && exists) error(409, `A device already exists at ${ip}`);

	// Normalise/sanitise every field via the shared parser before persisting.
	const config = parseConfig(JSON.stringify(body.config ?? {}), ip);

	await saveDeviceConfig(ip, config);
	return json({ ok: true, ip });
};
