/**
 * Gateway (IPSec site) helpers backed by Valkey.
 *
 * Three keys describe one gateway, all keyed by the gateway's public IP:
 *   fleetipsec:psk:<ip>   -- shared secret (plain string)
 *   fleetipsec:site:<ip>  -- JSON crypto/tunnel record (SiteRecord)
 *   fleetipsec:nat:<ip>   -- JSON NAT record (device_nat[] + backend_nat)
 *
 * A gateway is identified in the store by its public IP; the customer_id
 * field of the site record must be globally unique and is the human handle.
 *
 * Systems behind a gateway are looked up read-only from
 *   systems:by-ip:<global_ip>
 * using the global_ip of each device_nat entry.
 *
 * Editing in the first UI step covers the site record + PSK only.  The NAT
 * record and the systems behind the gateway are shown read-only.
 */
import { getRedisClient } from '$lib/server/redis';

export const PSK_PREFIX  = 'fleetipsec:psk:';
export const SITE_PREFIX = 'fleetipsec:site:';
export const NAT_PREFIX  = 'fleetipsec:nat:';
export const SYS_PREFIX  = 'systems:by-ip:';

// ── Shapes exchanged with the browser ───────────────────────────────────────

/** Normalised, UI-friendly site record: every crypto field is an array. */
export interface SiteRecord {
	customer_id:     string;
	ike_identity:    string;      // '' when absent
	static_ip:       boolean;
	dyndns_password: string;      // '' when absent; only meaningful for dynamic IP
	ike_version:  number;      // 1 or 2
	ike_enc:      string[];
	ike_auth:     string[];
	ike_dh:       number[];
	esp_enc:      string[];
	esp_auth:     string[];
	esp_pfs:      number[];    // DH group numbers; empty = no PFS
	remote_ts:    string[];    // CIDR list
}

export interface GatewaySummary {
	ip:           string;
	customer_id:  string;
	static_ip:    boolean;
	ike_version:  number;
	device_count: number;
}

export interface DeviceEntry {
	internal_ip: string;
	global_ip:   string;
	system:      Record<string, string> | null;
}

export interface BackendNat {
	access_server?: string;
	sd_server?:     string;
	em_server?:     string;
}

export interface GatewayDetail {
	ip:          string;
	exists:      boolean;
	site:        SiteRecord;
	psk:         string;
	devices:     DeviceEntry[];
	backend_nat: BackendNat | null;
}

// ── Normalisation helpers ────────────────────────────────────────────────────

/** The daemon stores single values as scalars and multiples as arrays. */
function toStrArray(v: unknown): string[] {
	if (v === undefined || v === null) return [];
	if (Array.isArray(v)) return v.map(String);
	return [String(v)];
}

function toNumArray(v: unknown): number[] {
	if (v === undefined || v === null) return [];
	const arr = Array.isArray(v) ? v : [v];
	return arr.map(Number).filter(n => !Number.isNaN(n));
}

/** Collapse an array to a scalar when it holds a single element. */
function collapse<T>(arr: T[]): T | T[] {
	return arr.length === 1 ? arr[0] : arr;
}

/** Parse a raw site-record JSON string into the normalised UI shape. */
export function parseSite(raw: string | null): SiteRecord {
	let obj: Record<string, unknown> = {};
	if (raw) {
		try { obj = JSON.parse(raw); } catch { obj = {}; }
	}
	return {
		customer_id:     typeof obj.customer_id     === 'string' ? obj.customer_id     : '',
		ike_identity:    typeof obj.ike_identity    === 'string' ? obj.ike_identity    : '',
		static_ip:       obj.static_ip === undefined ? true : Boolean(obj.static_ip),
		dyndns_password: typeof obj.dyndns_password === 'string' ? obj.dyndns_password : '',
		ike_version:  Number(obj.ike_version) === 1 ? 1 : 2,
		ike_enc:      toStrArray(obj.ike_enc),
		ike_auth:     toStrArray(obj.ike_auth),
		ike_dh:       toNumArray(obj.ike_dh),
		esp_enc:      toStrArray(obj.esp_enc),
		esp_auth:     toStrArray(obj.esp_auth),
		esp_pfs:      toNumArray(obj.esp_pfs),
		remote_ts:    toStrArray(obj.remote_ts),
	};
}

/** Serialise a normalised site record back to the daemon's JSON shape. */
export function serialiseSite(s: SiteRecord): string {
	const out: Record<string, unknown> = {
		customer_id: s.customer_id,
		static_ip:   s.static_ip,
		ike_version: s.ike_version,
	};
	if (s.ike_identity.trim()) out.ike_identity = s.ike_identity.trim();
	// DynDNS password is only relevant for dynamic-IP gateways.
	if (!s.static_ip && s.dyndns_password) out.dyndns_password = s.dyndns_password;
	if (s.ike_enc.length)  out.ike_enc  = collapse(s.ike_enc);
	if (s.ike_auth.length) out.ike_auth = collapse(s.ike_auth);
	if (s.ike_dh.length)   out.ike_dh   = collapse(s.ike_dh);
	if (s.esp_enc.length)  out.esp_enc  = collapse(s.esp_enc);
	if (s.esp_auth.length) out.esp_auth = collapse(s.esp_auth);
	if (s.esp_pfs.length)  out.esp_pfs  = collapse(s.esp_pfs);
	if (s.remote_ts.length) out.remote_ts = s.remote_ts;
	return JSON.stringify(out);
}

// ── Search-query parser ──────────────────────────────────────────────────────
//
// Grammar (first version -- ip and id only):
//   query   := token (WS token)*          -- whitespace-separated, ANDed
//   token   := alt ('|' alt)*             -- pipe-separated, ORed
//   alt     := field ':' value | value    -- bare value matches ip OR id
//   field   := 'ip' | 'id'

type Term  = { field: 'ip' | 'id' | 'any'; value: string };
type AndGroup = Term[];   // ORed alternatives
export type ParsedQuery = AndGroup[];

export function parseQuery(q: string): ParsedQuery {
	const groups: ParsedQuery = [];
	for (const token of q.trim().split(/\s+/).filter(Boolean)) {
		const alts: AndGroup = [];
		for (const alt of token.split('|').filter(Boolean)) {
			const idx = alt.indexOf(':');
			if (idx > 0) {
				const field = alt.slice(0, idx).toLowerCase();
				const value = alt.slice(idx + 1).toLowerCase();
				if (field === 'ip' || field === 'id') {
					alts.push({ field, value });
					continue;
				}
			}
			alts.push({ field: 'any', value: alt.toLowerCase() });
		}
		if (alts.length) groups.push(alts);
	}
	return groups;
}

function matchTerm(t: Term, ip: string, customerId: string): boolean {
	const lip = ip.toLowerCase();
	const lid = customerId.toLowerCase();
	switch (t.field) {
		case 'ip':  return lip.includes(t.value);
		case 'id':  return lid.includes(t.value);
		default:    return lip.includes(t.value) || lid.includes(t.value);
	}
}

function matchGateway(q: ParsedQuery, ip: string, customerId: string): boolean {
	// AND across groups; OR within a group.  Empty query matches everything.
	return q.every(group => group.some(t => matchTerm(t, ip, customerId)));
}

// ── Store access ─────────────────────────────────────────────────────────────

/** Count device_nat entries in a raw NAT-record JSON string. */
function deviceCount(rawNat: string | null): number {
	if (!rawNat) return 0;
	try {
		const obj = JSON.parse(rawNat);
		return Array.isArray(obj.device_nat) ? obj.device_nat.length : 0;
	} catch {
		return 0;
	}
}

/**
 * Search gateways.  An empty query returns every gateway (browse mode).
 * Scans fleetipsec:site:* keys; low-hundreds cardinality is expected.
 */
export async function searchGateways(rawQuery: string): Promise<GatewaySummary[]> {
	const redis = await getRedisClient();
	const q     = parseQuery(rawQuery);
	const out: GatewaySummary[] = [];

	for await (const batch of redis.scanIterator({ MATCH: `${SITE_PREFIX}*`, COUNT: 100 })) {
		for (const key of batch as string[]) {
			const ip   = key.slice(SITE_PREFIX.length);
			const raw  = await redis.get(key);
			const site = parseSite(raw);
			if (!matchGateway(q, ip, site.customer_id)) continue;

			const rawNat = await redis.get(`${NAT_PREFIX}${ip}`);
			out.push({
				ip,
				customer_id:  site.customer_id,
				static_ip:    site.static_ip,
				ike_version:  site.ike_version,
				device_count: deviceCount(rawNat),
			});
		}
	}

	out.sort((a, b) => a.customer_id.localeCompare(b.customer_id) || a.ip.localeCompare(b.ip));
	return out;
}

/** Load the full detail for one gateway (site + psk + nat + systems). */
export async function loadGateway(ip: string): Promise<GatewayDetail> {
	const redis = await getRedisClient();

	const [rawSite, psk, rawNat] = await Promise.all([
		redis.get(`${SITE_PREFIX}${ip}`),
		redis.get(`${PSK_PREFIX}${ip}`),
		redis.get(`${NAT_PREFIX}${ip}`),
	]);

	const site   = parseSite(rawSite);
	const exists = rawSite !== null || psk !== null;

	// Devices from the NAT record, enriched with system attributes.
	const devices: DeviceEntry[] = [];
	let backend_nat: BackendNat | null = null;
	if (rawNat) {
		try {
			const nat = JSON.parse(rawNat);
			if (Array.isArray(nat.device_nat)) {
				for (const d of nat.device_nat) {
					const global_ip   = String(d.global_ip ?? '');
					const internal_ip = String(d.internal_ip ?? '');
					let system: Record<string, string> | null = null;
					if (global_ip) {
						const hash = await redis.hGetAll(`${SYS_PREFIX}${global_ip}`);
						if (Object.keys(hash).length) system = hash;
					}
					devices.push({ internal_ip, global_ip, system });
				}
			}
			if (nat.backend_nat && typeof nat.backend_nat === 'object') {
				backend_nat = nat.backend_nat as BackendNat;
			}
		} catch {
			// Malformed NAT record: show gateway without devices.
		}
	}

	return { ip, exists, site, psk: psk ?? '', devices, backend_nat };
}

/**
 * Find the gateway IP that currently owns a customer_id, if any.
 * Used to enforce global uniqueness of customer_id on save.
 */
export async function customerIdOwner(customerId: string): Promise<string | null> {
	const redis  = await getRedisClient();
	const target = customerId.trim().toLowerCase();
	if (!target) return null;

	for await (const batch of redis.scanIterator({ MATCH: `${SITE_PREFIX}*`, COUNT: 100 })) {
		for (const key of batch as string[]) {
			const raw  = await redis.get(key);
			const site = parseSite(raw);
			if (site.customer_id.trim().toLowerCase() === target) {
				return key.slice(SITE_PREFIX.length);
			}
		}
	}
	return null;
}

/** True when a gateway already exists at this IP (site or psk key present). */
export async function gatewayExists(ip: string): Promise<boolean> {
	const redis = await getRedisClient();
	const [site, psk] = await Promise.all([
		redis.exists(`${SITE_PREFIX}${ip}`),
		redis.exists(`${PSK_PREFIX}${ip}`),
	]);
	return site > 0 || psk > 0;
}

/** Persist the site record and PSK for a gateway. */
export async function saveGateway(ip: string, site: SiteRecord, psk: string): Promise<void> {
	const redis = await getRedisClient();
	await Promise.all([
		redis.set(`${SITE_PREFIX}${ip}`, serialiseSite(site)),
		redis.set(`${PSK_PREFIX}${ip}`, psk),
	]);
}
