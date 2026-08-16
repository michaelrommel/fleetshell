// scripts/spool-infoproxy.mjs -- spool the Info Proxy authorization into Valkey.
//
// Flattens the master data  binding -> collection -> rule  into a per-source-IP
// allow-list keyed by the Squid CLIENT IP (the only stable identity Squid sees
// at request time). Device modality/product/serial is resolved OFFLINE here via
//   device.ip_address -> device -> product model -> matching bindings.
//
// Key layout (two independent Squids, namespaced by proxy_type):
//
//   SET  infoproxy:<proxy_type>:<source_ip>   members = allowed destinations
//        proxy_type = 'intranet' | 'internet'
//
// Each member is a TAB-delimited tuple the Squid helper matches:
//   <dns>\t<cidr>\t<port_from>\t<port_to>\t<protocol>
// Absence of the key => default DENY. See src/lib/server/infoproxy.ts and
// the squid-infoproxy Rust package.
//
// Authoritative export: rewrites every key from the DB and prunes stale keys.
//
// Reads settings from the environment (or a local .env):
//   GLOBAL_DB_HOST/PORT/NAME/USER/PASSWORD, PGSSL, VALKEY_URL,
//   VALKEY_TLS_REJECT_UNAUTHORIZED.
//
// Run from the portal dir:
//   node scripts/spool-infoproxy.mjs

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createClient } from 'redis';

// --- tiny .env loader (no dotenv dep); real env vars win ---------------------
try {
	for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && process.env[m[1]] === undefined) {
			process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	}
} catch { /* no .env -- rely on real env */ }

const SEP = '\t';
export const infoproxyKey = (proxyType, ip) => `infoproxy:${proxyType}:${ip}`;
const encodeRule = (r) => [
	r.dns ?? '', r.cidr ?? '',
	r.port_from == null ? '' : String(r.port_from),
	r.port_to == null ? '' : String(r.port_to),
	r.protocol ?? '',
].join(SEP);

const sql = postgres({
	host: process.env.GLOBAL_DB_HOST ?? 'localhost',
	port: Number(process.env.GLOBAL_DB_PORT ?? 5432),
	database: process.env.GLOBAL_DB_NAME,
	username: process.env.GLOBAL_DB_USER ?? 'fsadmin',
	password: process.env.GLOBAL_DB_PASSWORD,
	ssl: process.env.PGSSL === 'disable' ? false : 'require',
	max: 4,
});

const url = process.env.VALKEY_URL ?? 'rediss://localhost:6380';
const rejectUnauthorized = process.env.VALKEY_TLS_REJECT_UNAUTHORIZED !== 'false';
const redis = createClient({
	url,
	socket: url.startsWith('rediss://') ? { tls: true, rejectUnauthorized } : undefined,
});
redis.on('error', (e) => console.error('[valkey]', e.message));

async function scanKeys(match) {
	const keys = [];
	for await (const batch of redis.scanIterator({ MATCH: match, COUNT: 1000 })) {
		for (const k of Array.isArray(batch) ? batch : [batch]) keys.push(k);
	}
	return keys;
}

async function main() {
	await redis.connect();

	// Resolve every device with an IP to its effective rules, per proxy type.
	const rows = await sql`
		SELECT c.proxy_type, d.ip_address,
		       r.target_dns AS dns, r.target_cidr::text AS cidr,
		       r.target_port_from AS port_from, r.target_port_to AS port_to, r.protocol
		FROM device d
		LEFT JOIN product m ON m.path = d.product_path
		JOIN proxy_destination_binding b
		  ON (b.device_id IS NULL OR b.device_id = d.id)
		 AND (b.product_id IS NULL OR b.product_id = m.id)
		JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
		JOIN proxy_destination_rule r            ON r.collection_id = c.id
		WHERE d.ip_address IS NOT NULL AND d.ip_address <> ''`;

	// proxy_type -> ip -> Set(member)
	const byType = new Map();
	for (const r of rows) {
		let byIp = byType.get(r.proxy_type);
		if (!byIp) byType.set(r.proxy_type, (byIp = new Map()));
		let set = byIp.get(r.ip_address);
		if (!set) byIp.set(r.ip_address, (set = new Set()));
		set.add(encodeRule(r));
	}

	// Rewrite each source-IP key (single-key DEL + SADD => same slot).
	const desired = new Set();
	let written = 0;
	const perType = {};
	for (const [proxyType, byIp] of byType) {
		for (const [ip, members] of byIp) {
			const key = infoproxyKey(proxyType, ip);
			desired.add(key);
			const multi = redis.multi();
			multi.del(key);
			multi.sAdd(key, [...members]);
			await multi.exec();
			written++;
			perType[proxyType] = (perType[proxyType] ?? 0) + 1;
		}
	}

	// Prune stale keys.
	const stale = (await scanKeys('infoproxy:*')).filter((k) => !desired.has(k));
	const CHUNK = 500;
	for (let i = 0; i < stale.length; i += CHUNK) {
		await Promise.all(stale.slice(i, i + CHUNK).map((k) => redis.unlink(k)));
	}

	const detail = Object.entries(perType).map(([t, n]) => `${n} ${t}`).join(', ');
	console.log(`spooled ${written} infoproxy source-IP allow-lists`
		+ (detail ? ` (${detail})` : '')
		+ (stale.length ? `; dropped ${stale.length} stale keys` : ''));
	await redis.quit();
	await sql.end();
}

main().catch(async (e) => {
	console.error(e);
	try { await redis.quit(); } catch {}
	try { await sql.end(); } catch {}
	process.exit(1);
});
