// scripts/spool-device.mjs -- (re)spool ONE device's systems:by-ip hash, then its
// gateway. Write-through on save already keeps Valkey current; this is for
// manual/test use. Single-target by device id OR IP address.
//
//   node scripts/spool-device.mjs <device-id|ip-address>
//
// Key (see src/lib/server/device_spool.ts + docs/valkey_spool.md):
//   HASH  systems:by-ip:<device.ip_address>   { modality, product, partno,
//         serial, country, dtm, contracts }
//
// Reads GLOBAL_DB_* / PGSSL / VALKEY_URL / VALKEY_TLS_REJECT_UNAUTHORIZED from
// the environment or a local .env.

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createClient } from 'redis';

try {
	for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
	}
} catch { /* no .env */ }

const target = process.argv[2];
if (!target) { console.error('usage: node scripts/spool-device.mjs <device-id|ip-address>'); process.exit(2); }

function buildDeviceHash(r) {
	const contracts = [];
	if (r.internal_use) contracts.push(r.internal_use);
	if (r.dpa) contracts.push('DPA');
	if (r.dmy) contracts.push('DMY');
	const hash = {};
	const put = (k, v) => { if (v != null && v !== '') hash[k] = v; };
	put('modality', r.modality); put('product', r.product); put('partno', r.partno);
	put('serial', r.serial); put('country', r.country_iso); put('dtm', r.dtm || 'STD');
	if (contracts.length) hash.contracts = contracts.join(',');
	return hash;
}
const strArray = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map(String).filter((s) => s !== ''));
const numArray = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map(Number).filter((n) => !Number.isNaN(n)));
function buildSiteRecord(s) {
	if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = {}; } }
	s = (s && typeof s === 'object') ? s : {};
	const staticIp = s.static_ip === undefined ? true : Boolean(s.static_ip);
	const out = { ike_version: Number(s.ike_version) === 1 ? 1 : 2, static_ip: staticIp };
	if (typeof s.ike_identity === 'string' && s.ike_identity.trim()) out.ike_identity = s.ike_identity.trim();
	if (!staticIp && s.dyndns_password) out.dyndns_password = s.dyndns_password;
	const put = (k, a) => { if (a.length) out[k] = a; };
	// Absent -> IpsecEditor default; present (even empty) -> as stored (esp_pfs [] = no PFS).
	put('ike_enc', s.ike_enc === undefined ? ['aes256'] : strArray(s.ike_enc));
	put('ike_auth', s.ike_auth === undefined ? ['sha256'] : strArray(s.ike_auth));
	put('ike_dh', s.ike_dh === undefined ? [14] : numArray(s.ike_dh));
	put('esp_enc', s.esp_enc === undefined ? ['aes256gcm'] : strArray(s.esp_enc));
	put('esp_auth', s.esp_auth === undefined ? ['none'] : strArray(s.esp_auth));
	put('esp_pfs', s.esp_pfs === undefined ? [14] : numArray(s.esp_pfs));
	put('remote_ts', strArray(s.remote_ts));
	return out;
}
function buildNatRecord(gw, devices) {
	const device_nat = [];
	for (const d of devices) {
		const global_ip = (d.ip_address ?? '').trim();
		if (!global_ip) continue;
		const internal_ip = d.nat_mode === 'platform' ? ((d.ip_real ?? '').trim() || global_ip) : global_ip;
		device_nat.push({ internal_ip, global_ip });
	}
	const backend = {};
	if (gw.backend_access_ip) backend.access_server = gw.backend_access_ip;
	if (gw.backend_sd_ip) backend.sd_server = gw.backend_sd_ip;
	if (gw.backend_em_ip) backend.em_server = gw.backend_em_ip;
	const rec = { device_nat };
	if (Object.keys(backend).length) rec.backend_nat = backend;
	return rec;
}

const sql = postgres({
	host: process.env.GLOBAL_DB_HOST ?? 'localhost', port: Number(process.env.GLOBAL_DB_PORT ?? 5432),
	database: process.env.GLOBAL_DB_NAME, username: process.env.GLOBAL_DB_USER ?? 'fsadmin',
	password: process.env.GLOBAL_DB_PASSWORD, ssl: process.env.PGSSL === 'disable' ? false : 'require', max: 4,
});
const url = process.env.VALKEY_URL ?? 'rediss://localhost:6380';
const redis = createClient({
	url,
	socket: url.startsWith('rediss://') ? { tls: true, rejectUnauthorized: process.env.VALKEY_TLS_REJECT_UNAUTHORIZED !== 'false' } : undefined,
});
redis.on('error', (e) => console.error('[valkey]', e.message));

async function spoolGateway(gatewayId) {
	const [gw] = await sql`
		SELECT id::text AS id, public_ip, psk, ipsec, backend_access_ip, backend_sd_ip, backend_em_ip
		FROM gateway WHERE id = ${gatewayId}`;
	if (!gw || !gw.public_ip) return null;
	const devices = await sql`SELECT ip_address, ip_real, nat_mode FROM device WHERE gateway_id = ${gw.id}`;
	const ip = gw.public_ip;
	if (gw.psk) await redis.set(`fleetipsec:psk:${ip}`, gw.psk); else await redis.unlink(`fleetipsec:psk:${ip}`);
	await redis.set(`fleetipsec:site:${ip}`, JSON.stringify(buildSiteRecord(gw.ipsec)));
	await redis.set(`fleetipsec:nat:${ip}`, JSON.stringify(buildNatRecord(gw, devices)));
	return ip;
}

async function main() {
	await redis.connect();
	const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
	const [row] = await sql`
		SELECT d.id::text AS id, d.ip_address AS ip, d.gateway_id::text AS gateway_id,
		       d.serial, d.country_iso, d.internal_use, d.dpa, d.dmy,
		       COALESCE(cu.dtm_variant, 'STD') AS dtm, pm.partno::text AS partno,
		       (SELECT md.name FROM product md WHERE md.path = subltree(d.product_path, 0, 2)) AS modality,
		       (SELECT pr.name FROM product pr WHERE pr.path = subpath(d.product_path, 0, nlevel(d.product_path) - 1)) AS product
		FROM device d
		LEFT JOIN product m        ON m.path = d.product_path
		LEFT JOIN product_model pm ON pm.product_id = m.id
		LEFT JOIN customer cu      ON cu.id = d.customer_id
		WHERE ${isUuid ? sql`d.id = ${target}` : sql`d.ip_address = ${target}`}`;
	if (!row) { console.error('device not found:', target); process.exit(1); }
	if (!row.ip) { console.error('device has no ip_address; nothing to spool'); process.exit(1); }

	const key = `systems:by-ip:${row.ip}`;
	const hash = buildDeviceHash(row);
	await redis.del(key);
	if (Object.keys(hash).length) await redis.hSet(key, hash);
	console.log(`spooled ${key}`, hash);
	if (row.gateway_id) {
		const ip = await spoolGateway(row.gateway_id);
		if (ip) console.log(`re-spooled gateway ${ip}`);
	}
	await redis.quit(); await sql.end();
}
main().catch(async (e) => { console.error(e); try { await redis.quit(); } catch {} try { await sql.end(); } catch {} process.exit(1); });
