// src/lib/server/gateway_spool.ts
//
// Gateway (IPsec site) Valkey spooler. Owns the fleetipsec:* keys, keyed by the
// gateway's public IP:
//
//   fleetipsec:psk:<public_ip>   -- plain string PSK            (gateway.psk)
//   fleetipsec:site:<public_ip>  -- JSON SiteRecord (crypto)    (gateway.ipsec)
//   fleetipsec:nat:<public_ip>   -- JSON NAT record             (attached devices + backend IPs)
//
// Consumed by the ipsecnode fleet (see /home/rommel/software/fleetsuite/ipsecnode).
// Spooling is WRITE-THROUGH on gateway/device save (not a bulk export): keys only
// exist for gateways that have actually been touched + given a public_ip. See
// docs/valkey_spool.md.
//
// Notes verified against ipsecnode:
//   * SiteRecord crypto fields are ALWAYS emitted as arrays (ipsecnode's
//     OneOrMany deserializer accepts arrays natively; the old single-element
//     "collapse" quirk is dropped). `customer_id` is NOT spooled (ipsecnode never
//     reads it).
//   * device_nat[].internal_ip is the real SNAT/DNAT source and is REQUIRED;
//     global_ip = device.ip_address. Per the SITE's gateway.nat_mode: 'backend'
//     -> ip_real (we translate), 'customer' -> ip_address (identity, no VPP NAT).
//   * nat_mode is emitted on BOTH the site and nat records so each ipsecnode
//     consumer reads it from the record it already fetches (credentials.rs from
//     :site, vpp.rs from :nat). 'customer' => VPP bypass; 'backend' => VPP NAT44.
//   * backend_nat is OMITTED when none of the three IPs is set (ipsecnode treats
//     it as an Option and installs no backend DNAT roles).

import { getRedisClient } from '$lib/server/redis';
import { globalDb } from '$lib/server/db';

export const PSK_PREFIX = 'fleetipsec:psk:';
export const SITE_PREFIX = 'fleetipsec:site:';
export const NAT_PREFIX = 'fleetipsec:nat:';

type GatewayRow = {
	id: string;
	public_ip: string | null;
	psk: string | null;
	ipsec: Record<string, unknown> | null;
	nat_mode: string;
	backend_access_ip: string | null;
	backend_sd_ip: string | null;
	backend_em_ip: string | null;
};

type DeviceNatRow = { ip_address: string | null; ip_real: string | null };

/** Coerce a jsonb value into a string array (missing -> []). */
function strArray(v: unknown): string[] {
	if (v == null) return [];
	return (Array.isArray(v) ? v : [v]).map(String).filter((s) => s !== '');
}
/** Coerce a jsonb value into a number array (missing -> []). */
function numArray(v: unknown): number[] {
	if (v == null) return [];
	return (Array.isArray(v) ? v : [v]).map(Number).filter((n) => !Number.isNaN(n));
}

/**
 * Build the SiteRecord JSON from gateway.ipsec. Crypto fields are always arrays;
 * `customer_id` is intentionally absent (ipsecnode never reads it).
 *
 * ipsecnode has weak internal fallbacks, but a mismatch with the customer breaks
 * the tunnel, so we spool an EXPLICIT, complete crypto set: any field ABSENT from
 * the stored record is filled with the same default the IpsecEditor shows. An
 * explicitly-empty value is respected (e.g. esp_pfs = [] -> no PFS).
 */
export function buildSiteRecord(ipsec: unknown, natMode: string): Record<string, unknown> {
	// Tolerate a legacy double-encoded row (jsonb string) by parsing it once.
	let s: Record<string, unknown> = {};
	if (typeof ipsec === 'string') {
		try { const p = JSON.parse(ipsec); if (p && typeof p === 'object') s = p as Record<string, unknown>; } catch { /* keep {} */ }
	} else if (ipsec && typeof ipsec === 'object') {
		s = ipsec as Record<string, unknown>;
	}
	const staticIp = s.static_ip === undefined ? true : Boolean(s.static_ip);
	const out: Record<string, unknown> = {
		ike_version: Number(s.ike_version) === 1 ? 1 : 2,
		static_ip: staticIp,
		nat_mode: natMode === 'backend' ? 'backend' : 'customer',
	};
	if (typeof s.ike_identity === 'string' && s.ike_identity.trim()) out.ike_identity = s.ike_identity.trim();
	if (!staticIp && typeof s.dyndns_password === 'string' && s.dyndns_password) out.dyndns_password = s.dyndns_password;

	// Absent -> IpsecEditor default; present (even empty) -> as stored.
	const ikeEnc = s.ike_enc === undefined ? ['aes256'] : strArray(s.ike_enc); if (ikeEnc.length) out.ike_enc = ikeEnc;
	const ikeAuth = s.ike_auth === undefined ? ['sha256'] : strArray(s.ike_auth); if (ikeAuth.length) out.ike_auth = ikeAuth;
	const ikeDh = s.ike_dh === undefined ? [14] : numArray(s.ike_dh); if (ikeDh.length) out.ike_dh = ikeDh;
	const espEnc = s.esp_enc === undefined ? ['aes256gcm'] : strArray(s.esp_enc); if (espEnc.length) out.esp_enc = espEnc;
	const espAuth = s.esp_auth === undefined ? ['none'] : strArray(s.esp_auth); if (espAuth.length) out.esp_auth = espAuth;
	const espPfs = s.esp_pfs === undefined ? [14] : numArray(s.esp_pfs); if (espPfs.length) out.esp_pfs = espPfs;
	const remoteTs = strArray(s.remote_ts); if (remoteTs.length) out.remote_ts = remoteTs;
	const localTs = strArray(s.local_ts); if (localTs.length) out.local_ts = localTs;
	return out;
}

/** Build the NAT record from the gateway's attached devices + backend IPs. */
export function buildNatRecord(gw: GatewayRow, devices: DeviceNatRow[]): Record<string, unknown> {
	const backendMode = gw.nat_mode === 'backend';
	const device_nat: { internal_ip: string; global_ip: string }[] = [];
	for (const d of devices) {
		const global_ip = (d.ip_address ?? '').trim();
		if (!global_ip) continue;                                   // no global IP -> nothing to route
		// backend NAT: our side translates ip_real -> global_ip; customer NAT:
		// identity (customer already NATted / addresses unique, internal == global).
		const internal_ip = backendMode ? ((d.ip_real ?? '').trim() || global_ip) : global_ip;
		device_nat.push({ internal_ip, global_ip });
	}

	const backend: Record<string, string> = {};
	if (gw.backend_access_ip) backend.access_server = gw.backend_access_ip;
	if (gw.backend_sd_ip) backend.sd_server = gw.backend_sd_ip;
	if (gw.backend_em_ip) backend.em_server = gw.backend_em_ip;

	const rec: Record<string, unknown> = {
		nat_mode: backendMode ? 'backend' : 'customer',
		device_nat,
	};
	if (Object.keys(backend).length) rec.backend_nat = backend;    // omit when unset
	return rec;
}

/** Delete all three fleetipsec:* keys for a public IP. */
export async function deleteGatewayKeys(publicIp: string): Promise<void> {
	if (!publicIp) return;
	const redis = await getRedisClient();
	await redis.unlink([`${PSK_PREFIX}${publicIp}`, `${SITE_PREFIX}${publicIp}`, `${NAT_PREFIX}${publicIp}`]);
}

/**
 * Spool one gateway's fleetipsec:* keys from Aurora. Returns the public IP that
 * was written, or null when the gateway has no public_ip (nothing to key on).
 */
export async function spoolGateway(gatewayId: string): Promise<string | null> {
	const [gw] = await globalDb<GatewayRow[]>`
		SELECT id::text AS id, public_ip, psk, ipsec, nat_mode,
		       backend_access_ip, backend_sd_ip, backend_em_ip
		FROM gateway WHERE id = ${gatewayId}`;
	if (!gw || !gw.public_ip) return null;
	const ip = gw.public_ip;

	const devices = await globalDb<DeviceNatRow[]>`
		SELECT ip_address, ip_real FROM device WHERE gateway_id = ${gatewayId}`;

	const redis = await getRedisClient();
	if (gw.psk) await redis.set(`${PSK_PREFIX}${ip}`, gw.psk);
	else await redis.unlink(`${PSK_PREFIX}${ip}`);
	await redis.set(`${SITE_PREFIX}${ip}`, JSON.stringify(buildSiteRecord(gw.ipsec, gw.nat_mode)));
	await redis.set(`${NAT_PREFIX}${ip}`, JSON.stringify(buildNatRecord(gw, devices)));
	return ip;
}

/**
 * Write-through on gateway save: (re)spool the gateway, and if its public_ip
 * changed, remove the stale keys under the previous IP.
 */
export async function spoolGatewayOnSave(gatewayId: string, prevPublicIp: string | null): Promise<void> {
	const ip = await spoolGateway(gatewayId);
	if (prevPublicIp && prevPublicIp !== ip) await deleteGatewayKeys(prevPublicIp);
}
