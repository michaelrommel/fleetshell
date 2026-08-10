/**
 * Device helpers backed by Valkey.
 *
 * A device is a hash at:
 *   systems:by-ip:<ip>
 *
 * The aeroftp project owns the flat scalar fields (modality, product, partno,
 * serial, country, contracts, dtm, ...).  Those are left untouched here.
 *
 * FleetShell stores its per-device application configuration as a single JSON
 * string in the additional hash field:
 *   app_config
 *
 * app_config shape:
 *   {
 *     "target":     "172.16.33.10",       // device-reachable IP for the tunnel
 *     "gateway":    "gateway.fleetshell.com",
 *     "servicekey": "...",
 *     "apps": [ AppProfile, ... ]
 *   }
 *
 * Credentials (username / password) are never stored; they are entered at
 * connect time.
 */
import { getRedisClient } from '$lib/server/redis';

export const SYS_PREFIX       = 'systems:by-ip:';
export const APP_CONFIG_FIELD = 'app_config';

export type Application = 'http' | 'https' | 'expert-i' | 'rdp' | 'vnc' | 'ssh';

/** One configured application/port profile for a device. */
export interface AppProfile {
	name:        string;
	ports:       string;
	application: Application;
	guac:        boolean;
	e2ecrypt:    boolean;
	sni:         string;
	path:        string;
	width:       number;
	height:      number;
	dpi:         number;
	drive:       boolean;
	record:      boolean;
}

export interface DeviceConfig {
	target:     string;
	gateway:    string;
	servicekey: string;
	apps:       AppProfile[];
}

export interface DeviceSummary {
	ip:        string;
	fields:    Record<string, string>;   // aeroftp scalar fields (no app_config)
	app_count: number;
}

export interface DeviceDetail {
	ip:     string;
	exists: boolean;
	fields: Record<string, string>;       // aeroftp scalar fields (no app_config)
	config: DeviceConfig;
}

// ── Defaults / normalisation ─────────────────────────────────────────────────

const APPLICATIONS: Application[] = ['http', 'https', 'expert-i', 'rdp', 'vnc', 'ssh'];

export function blankAppProfile(): AppProfile {
	return {
		name: '', ports: '', application: 'https',
		guac: false, e2ecrypt: false, sni: '', path: '/',
		width: 1920, height: 1080, dpi: 96, drive: false, record: false,
	};
}

function normaliseApp(raw: unknown): AppProfile {
	const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
	const application = APPLICATIONS.includes(o.application as Application)
		? o.application as Application : 'https';
	const num = (v: unknown, def: number) => {
		const n = Number(v);
		return Number.isFinite(n) ? n : def;
	};
	return {
		name:        typeof o.name === 'string' ? o.name : '',
		ports:       typeof o.ports === 'string' ? o.ports : String(o.ports ?? ''),
		application,
		guac:        Boolean(o.guac),
		e2ecrypt:    Boolean(o.e2ecrypt),
		sni:         typeof o.sni  === 'string' ? o.sni  : '',
		path:        typeof o.path === 'string' && o.path ? o.path : '/',
		width:       num(o.width, 1920),
		height:      num(o.height, 1080),
		dpi:         num(o.dpi, 96),
		drive:       Boolean(o.drive),
		record:      Boolean(o.record),
	};
}

/** Parse the app_config JSON string into a normalised DeviceConfig. */
export function parseConfig(raw: string | undefined, fallbackTarget = ''): DeviceConfig {
	let obj: Record<string, unknown> = {};
	if (raw) {
		try { obj = JSON.parse(raw); } catch { obj = {}; }
	}
	return {
		target:     typeof obj.target     === 'string' ? obj.target     : fallbackTarget,
		gateway:    typeof obj.gateway    === 'string' ? obj.gateway    : '',
		servicekey: typeof obj.servicekey === 'string' ? obj.servicekey : '',
		apps:       Array.isArray(obj.apps) ? obj.apps.map(normaliseApp) : [],
	};
}

/** Serialise a DeviceConfig back to the stored JSON shape. */
export function serialiseConfig(cfg: DeviceConfig): string {
	return JSON.stringify({
		target:     cfg.target,
		gateway:    cfg.gateway,
		servicekey: cfg.servicekey,
		apps:       cfg.apps.map(normaliseApp),
	});
}

// ── Search-query parser (Google-style: ip:, id:, field:value) ─────────────────
//
//   query := token (WS token)*     -- whitespace-separated, ANDed
//   token := alt ('|' alt)*        -- pipe-separated, ORed
//   alt   := field ':' value | value
//   field := 'ip' | any hash-field name (serial, product, country, ...)
//   bare value matches the ip OR any field value.

type Term  = { field: string; value: string };   // field 'any' for bare terms
type Group = Term[];
type Query = Group[];

function parseQuery(q: string): Query {
	const groups: Query = [];
	for (const token of q.trim().split(/\s+/).filter(Boolean)) {
		const alts: Group = [];
		for (const alt of token.split('|').filter(Boolean)) {
			const idx = alt.indexOf(':');
			if (idx > 0) {
				alts.push({ field: alt.slice(0, idx).toLowerCase(), value: alt.slice(idx + 1).toLowerCase() });
			} else {
				alts.push({ field: 'any', value: alt.toLowerCase() });
			}
		}
		if (alts.length) groups.push(alts);
	}
	return groups;
}

function matchTerm(t: Term, ip: string, fields: Record<string, string>): boolean {
	const lip = ip.toLowerCase();
	if (t.field === 'any') {
		return lip.includes(t.value) ||
			Object.values(fields).some(v => v.toLowerCase().includes(t.value));
	}
	if (t.field === 'ip') return lip.includes(t.value);
	const fv = fields[t.field];
	return fv !== undefined && fv.toLowerCase().includes(t.value);
}

function matchDevice(q: Query, ip: string, fields: Record<string, string>): boolean {
	return q.every(group => group.some(t => matchTerm(t, ip, fields)));
}

// ── Store access ─────────────────────────────────────────────────────────────

/** Split the raw hash into aeroftp scalar fields and the app_config string. */
function splitHash(hash: Record<string, string>): {
	fields: Record<string, string>;
	rawConfig: string | undefined;
} {
	const { [APP_CONFIG_FIELD]: rawConfig, ...fields } = hash;
	return { fields, rawConfig };
}

/**
 * Search devices.  An empty query returns every device (browse mode).
 * Scans systems:by-ip:* keys; low-hundreds cardinality is expected.
 */
export async function searchDevices(rawQuery: string): Promise<DeviceSummary[]> {
	const redis = await getRedisClient();
	const q     = parseQuery(rawQuery);
	const out: DeviceSummary[] = [];

	for await (const batch of redis.scanIterator({ MATCH: `${SYS_PREFIX}*`, COUNT: 100 })) {
		for (const key of batch as string[]) {
			const ip   = key.slice(SYS_PREFIX.length);
			const hash = await redis.hGetAll(key);
			const { fields, rawConfig } = splitHash(hash);
			if (!matchDevice(q, ip, fields)) continue;

			const cfg = parseConfig(rawConfig);
			out.push({ ip, fields, app_count: cfg.apps.length });
		}
	}

	out.sort((a, b) => a.ip.localeCompare(b.ip));
	return out;
}

/** Load full detail for one device (aeroftp fields + app config). */
export async function loadDevice(ip: string): Promise<DeviceDetail> {
	const redis = await getRedisClient();
	const hash  = await redis.hGetAll(`${SYS_PREFIX}${ip}`);
	const exists = Object.keys(hash).length > 0;
	const { fields, rawConfig } = splitHash(hash);
	const config = parseConfig(rawConfig, ip);
	return { ip, exists, fields, config };
}

/** True when a device hash already exists at this IP. */
export async function deviceExists(ip: string): Promise<boolean> {
	const redis = await getRedisClient();
	return (await redis.exists(`${SYS_PREFIX}${ip}`)) > 0;
}

/** Persist the app_config field only, leaving aeroftp scalar fields untouched. */
export async function saveDeviceConfig(ip: string, config: DeviceConfig): Promise<void> {
	const redis = await getRedisClient();
	await redis.hSet(`${SYS_PREFIX}${ip}`, APP_CONFIG_FIELD, serialiseConfig(config));
}
