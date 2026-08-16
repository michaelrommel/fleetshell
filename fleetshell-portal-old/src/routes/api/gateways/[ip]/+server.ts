/**
 * GET  /api/gateways/<ip>   -- load full gateway detail (site + psk + nat).
 * PUT  /api/gateways/<ip>   -- upsert the site record and PSK.
 *
 * Editing covers the site record + PSK only.  The NAT record and the systems
 * behind the gateway are read-only in this first UI step.
 *
 * PUT body:
 *   {
 *     site: SiteRecord,       // normalised UI shape (crypto fields as arrays)
 *     psk:  string,
 *     create?: boolean        // when true, refuse to overwrite an existing key
 *   }
 */
import { json, error }          from '@sveltejs/kit';
import {
	loadGateway,
	saveGateway,
	gatewayExists,
	customerIdOwner,
	type SiteRecord,
}                               from '$lib/server/gateways';
import type { RequestHandler }   from './$types';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIpv4(ip: string): boolean {
	const m = IPV4_RE.exec(ip);
	if (!m) return false;
	return m.slice(1).every(o => Number(o) <= 255);
}

const IKE_ENC  = ['aes128', 'aes192', 'aes256'];
const IKE_AUTH = ['sha256', 'sha384', 'sha512'];
const DH_GROUPS = [1, 2, 5, 14, 15, 16, 19, 20, 21, 24];
const ESP_ENC  = ['aes128', 'aes192', 'aes256', 'aes128gcm', 'aes192gcm', 'aes256gcm', 'none'];
const ESP_AUTH = ['sha256', 'sha384', 'sha512', 'none'];

function sanitiseStr(input: unknown, allowed: string[]): string[] {
	if (!Array.isArray(input)) return [];
	return input.map(String).filter(v => allowed.includes(v));
}
function sanitiseNum(input: unknown, allowed: number[]): number[] {
	if (!Array.isArray(input)) return [];
	return input.map(Number).filter(v => allowed.includes(v));
}

// ── GET ──────────────────────────────────────────────────────────────────────

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	const ip = params.ip ?? '';
	if (!isValidIpv4(ip)) error(400, 'Invalid gateway IP');
	const gateway = await loadGateway(ip);
	return json({ gateway });
};

// ── PUT (upsert) ───────────────────────────────────────────────────────────

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const ip = params.ip ?? '';
	if (!isValidIpv4(ip)) error(400, 'Invalid gateway IP');

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') error(400, 'Invalid JSON body');

	const rawSite = body.site ?? {};
	const psk     = typeof body.psk === 'string' ? body.psk : '';
	const create  = body.create === true;

	const customer_id = String(rawSite.customer_id ?? '').trim();
	if (!customer_id) error(400, 'customer_id is required');

	// customer_id must be globally unique.
	const owner = await customerIdOwner(customer_id);
	if (owner && owner !== ip) {
		error(409, `customer_id "${customer_id}" is already used by gateway ${owner}`);
	}

	const exists = await gatewayExists(ip);
	if (create && exists) {
		error(409, `A gateway already exists at ${ip}`);
	}
	if (create && !psk.trim()) {
		error(400, 'A PSK is required when creating a gateway');
	}

	const site: SiteRecord = {
		customer_id,
		ike_identity: String(rawSite.ike_identity ?? '').trim(),
		static_ip:    Boolean(rawSite.static_ip),
		dyndns_password: String(rawSite.dyndns_password ?? ''),
		ike_version:  Number(rawSite.ike_version) === 1 ? 1 : 2,
		ike_enc:      sanitiseStr(rawSite.ike_enc,  IKE_ENC),
		ike_auth:     sanitiseStr(rawSite.ike_auth, IKE_AUTH),
		ike_dh:       sanitiseNum(rawSite.ike_dh,   DH_GROUPS),
		esp_enc:      sanitiseStr(rawSite.esp_enc,  ESP_ENC),
		esp_auth:     sanitiseStr(rawSite.esp_auth, ESP_AUTH),
		esp_pfs:      sanitiseNum(rawSite.esp_pfs,  DH_GROUPS),
		remote_ts:    Array.isArray(rawSite.remote_ts)
			? rawSite.remote_ts.map(String).map((s: string) => s.trim()).filter(Boolean)
			: [],
	};

	await saveGateway(ip, site, psk);
	return json({ ok: true, ip });
};
