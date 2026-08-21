// scripts/spool-infoproxy.mjs -- spool the Info Proxy authorization into Valkey.
//
// Flattens the master data  binding -> collection -> rule  into SCOPE-TIERED
// allow-lists the Squid helper unions at request time. Device modality/product/
// serial is resolved OFFLINE (here at spool time, and at request time via the
// shared device hash systems:by-ip:<ip>).
//
// Key layout (namespaced by proxy_type, then by scope tier):
//
//   SET  infoproxy:<proxy_type>:global          ANY/ANY bindings (every device)
//   SET  infoproxy:<proxy_type>:model:<partno>  bindings scoped to a model
//   SET  infoproxy:<proxy_type>:device:<ip>     device-specific bindings
//        proxy_type = 'intranet' | 'internet'
//        partno     = product_model.partno (one partno == one model; same value
//                     in systems:by-ip:<ip>.partno, so the helper resolves a
//                     client's model with one HGET)
//
// Tiering keeps writes O(change) not O(fleet): a global URL edit rewrites ONE
// key; adding/moving a device needs no infoproxy spool. Each member is a
// TAB-delimited tuple the Squid helper matches:
//   <dns>\t<cidr>\t<port_from>\t<port_to>\t<protocol>
// Absence of a tier key => that tier empty (default DENY overall). See
// src/lib/server/infoproxy.ts and the squid-infoproxy Rust package.
//
// Authoritative export: rewrites every key from the DB and prunes stale keys
// (including any legacy flat per-IP keys from the pre-tiered layout).
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
const infoproxyGlobalKey = (proxyType) => `infoproxy:${proxyType}:global`;
const infoproxyModelKey = (proxyType, partno) => `infoproxy:${proxyType}:model:${partno}`;
const infoproxyDeviceKey = (proxyType, ip) => `infoproxy:${proxyType}:device:${ip}`;
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

	// Rewrite each key (single-key DEL + SADD => same slot). Keys are STREAMED tier
	// by tier via server-side cursors and written one scope at a time, so peak
	// memory is one cursor batch + one scope's member set -- never the whole fleet.
	const CURSOR_BATCH = 2000;
	const PIPELINE_KEYS = 256;
	const desired = new Set();
	let written = 0;
	const perType = {};
	// Pipeline per-key MULTI/EXEC transactions: issue up to PIPELINE_KEYS without
	// awaiting (node-redis flushes them in one batch), then await as a group -- a
	// few socket flushes instead of thousands of sequential round-trips.
	let pending = [];
	const flushPending = async () => {
		if (pending.length === 0) return;
		const batch = pending;
		pending = [];
		await Promise.all(batch);
	};
	const writeKey = async (key, proxyType, members) => {
		desired.add(key);
		const multi = redis.multi();
		multi.del(key);
		if (members.size) multi.sAdd(key, [...members]);
		pending.push(multi.exec());
		written++;
		perType[proxyType] = (perType[proxyType] ?? 0) + 1;
		if (pending.length >= PIPELINE_KEYS) await flushPending();
	};

	// Walk a scoped tier (ordered by proxy_type, scope) and flush one key per scope.
	const streamScoped = async (rows, scopeOf, keyFor) => {
		let curType = null, curScope = null, members = new Set();
		const flush = async () => {
			if (curType === null || curScope === null) return;
			await writeKey(keyFor(curType, curScope), curType, members);
			members = new Set();
		};
		for await (const batch of rows) {
			for (const r of batch) {
				const scope = scopeOf(r);
				if (r.proxy_type !== curType || scope !== curScope) {
					await flush();
					curType = r.proxy_type; curScope = scope;
				}
				members.add(encodeRule(r));
			}
		}
		await flush();
	};

	// -- global tier: ANY device, ANY model (tiny -- accumulate then write) -------
	const globalRows = await sql`
		SELECT c.proxy_type,
		       r.target_dns AS dns, r.target_cidr::text AS cidr,
		       r.target_port_from AS port_from, r.target_port_to AS port_to, r.protocol
		FROM proxy_destination_binding b
		JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
		JOIN proxy_destination_rule r            ON r.collection_id = c.id
		WHERE b.device_id IS NULL AND b.product_id IS NULL`;
	const globalByType = new Map();
	for (const r of globalRows) {
		let set = globalByType.get(r.proxy_type);
		if (!set) globalByType.set(r.proxy_type, (set = new Set()));
		set.add(encodeRule(r));
	}
	for (const [proxyType, members] of globalByType) {
		await writeKey(infoproxyGlobalKey(proxyType), proxyType, members);
	}

	// -- model tier: scoped to a model, keyed by the model's partno (streamed) ----
	await streamScoped(
		sql`
			SELECT c.proxy_type, pm.partno::text AS partno,
			       r.target_dns AS dns, r.target_cidr::text AS cidr,
			       r.target_port_from AS port_from, r.target_port_to AS port_to, r.protocol
			FROM proxy_destination_binding b
			JOIN product_model pm                    ON pm.product_id = b.product_id
			JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
			JOIN proxy_destination_rule r            ON r.collection_id = c.id
			WHERE b.product_id IS NOT NULL AND b.device_id IS NULL AND pm.partno IS NOT NULL
			ORDER BY c.proxy_type, pm.partno`.cursor(CURSOR_BATCH),
		(r) => r.partno, infoproxyModelKey,
	);

	// -- device tier: device-specific bindings, keyed by the device IP (streamed) -
	await streamScoped(
		sql`
			SELECT c.proxy_type, d.ip_address,
			       r.target_dns AS dns, r.target_cidr::text AS cidr,
			       r.target_port_from AS port_from, r.target_port_to AS port_to, r.protocol
			FROM proxy_destination_binding b
			JOIN device d                            ON d.id = b.device_id
			LEFT JOIN product m                      ON m.path = d.product_path
			JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
			JOIN proxy_destination_rule r            ON r.collection_id = c.id
			WHERE b.device_id IS NOT NULL
			  AND (b.product_id IS NULL OR b.product_id = m.id)
			  AND d.ip_address IS NOT NULL AND d.ip_address <> ''
			ORDER BY c.proxy_type, d.ip_address`.cursor(CURSOR_BATCH),
		(r) => r.ip_address, infoproxyDeviceKey,
	);

	// Flush the last partial pipeline batch before scanning for stale keys.
	await flushPending();

	// Prune stale keys (scopes no longer present, and any legacy flat keys).
	const stale = (await scanKeys('infoproxy:*')).filter((k) => !desired.has(k));
	const CHUNK = 500;
	for (let i = 0; i < stale.length; i += CHUNK) {
		await Promise.all(stale.slice(i, i + CHUNK).map((k) => redis.unlink(k)));
	}

	const detail = Object.entries(perType).map(([t, n]) => `${n} ${t}`).join(', ');
	console.log(`spooled ${written} infoproxy tier keys`
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
