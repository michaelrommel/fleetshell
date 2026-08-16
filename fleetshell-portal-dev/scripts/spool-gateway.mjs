// scripts/spool-gateway.mjs -- (re)spool ONE gateway's fleetipsec:* keys.
//
// Write-through on save already keeps Valkey current; this is for manual/test use
// (re-push without editing). Single-target by gateway id OR public IP.
//
//   node scripts/spool-gateway.mjs <gateway-id|public-ip>
//
// Keys (see src/lib/server/gateway_spool.ts + docs/valkey_spool.md):
//   fleetipsec:psk:<public_ip>   fleetipsec:site:<public_ip>   fleetipsec:nat:<public_ip>
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
if (!target) { console.error('usage: node scripts/spool-gateway.mjs <gateway-id|public-ip>'); process.exit(2); }

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

async function main() {
	await redis.connect();
	const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
	const [gw] = await sql`
		SELECT id::text AS id, public_ip, psk, ipsec, backend_access_ip, backend_sd_ip, backend_em_ip
		FROM gateway WHERE ${isUuid ? sql`id = ${target}` : sql`public_ip = ${target}`}`;
	if (!gw) { console.error('gateway not found:', target); process.exit(1); }
	if (!gw.public_ip) { console.error('gateway has no public_ip; nothing to spool'); process.exit(1); }

	const devices = await sql`SELECT ip_address, ip_real, nat_mode FROM device WHERE gateway_id = ${gw.id}`;
	const ip = gw.public_ip;
	if (gw.psk) await redis.set(`fleetipsec:psk:${ip}`, gw.psk); else await redis.unlink(`fleetipsec:psk:${ip}`);
	await redis.set(`fleetipsec:site:${ip}`, JSON.stringify(buildSiteRecord(gw.ipsec)));
	await redis.set(`fleetipsec:nat:${ip}`, JSON.stringify(buildNatRecord(gw, devices)));
	console.log(`spooled gateway ${ip} (${devices.length} device_nat entries)`);
	await redis.quit(); await sql.end();
}
main().catch(async (e) => { console.error(e); try { await redis.quit(); } catch {} try { await sql.end(); } catch {} process.exit(1); });
