// scripts/spool-subscriptions.mjs -- spool File Subscriptions into Valkey for aeroftp.
//
// Resolves, per device product, the applicable file-matcher subscriptions and
// their (activated) delivery targets, mirroring the classification feature's
// per-product hash that aeroftp already consumes.
//
// Key layout (product-keyed, like data_classes:<MODALITY>:<PRODUCT>):
//
//   HASH  ftp_subscriptions:<MODALITY>:<PRODUCT>
//         field = subscription name
//         value = JSON { pattern, negate, servers: [ <server>, ... ] }
//
// <server> is the DENORMALIZED delivery target (single-lookup for aeroftp;
// secrets embedded PLAINTEXT, matching the subscriber_server.auth precedent):
//   { id, name, activated, delivery_method, host, country, use_case,
//     root_path, use_partno_folder, container_path, auth }
//
// NOTE on `activated`: a DEACTIVATED server is NOT skipped -- jobs are still
// enqueued for it during downtime so its backlog is delivered on reactivation;
// the handler fleet only *processes* activated servers. See
// docs/file_subscriptions.md.
//
// Applicability for product P in modality M: global (both NULL) + modality-wide
// (modality=M, product NULL) + product (product=P). A subscription with no
// attached server is dropped; a product with no applicable subscription has its
// key deleted. Authoritative export: prunes stale keys. See
// src/lib/server/subscriptions.ts.
//
// Reads settings from the environment (or a local .env):
//   GLOBAL_DB_HOST/PORT/NAME/USER/PASSWORD, PGSSL, VALKEY_URL,
//   VALKEY_TLS_REJECT_UNAUTHORIZED.
//
// Run from the portal dir:
//   node scripts/spool-subscriptions.mjs

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

export const subsKey = (modality, product) => `ftp_subscriptions:${modality}:${product}`;

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

	const products = await sql`
		SELECT p.id::text AS id, p.name AS product_name,
		       m.id::text AS modality_id, m.name AS modality_name
		FROM product p
		JOIN product m ON m.kind = 'modality' AND p.path <@ m.path
		WHERE p.kind = 'product'
		ORDER BY m.name, p.name`;

	const subs = await sql`
		SELECT id::text AS id, name, pattern, negate,
		       modality_id::text AS modality_id, product_id::text AS product_id
		FROM subscription`;

	const attachments = await sql`
		SELECT ss.subscription_id::text AS subscription_id,
		       s.id::text AS id, s.name, s.activated, s.delivery_method, s.ip_address AS host,
		       s.country, s.use_case, s.root_path, s.use_partno_folder,
		       s.container_path, s.auth
		FROM subscription_server ss
		JOIN subscriber_server s ON s.id = ss.server_id
		ORDER BY s.name`;

	const serversBySub = new Map();
	for (const a of attachments) {
		const { subscription_id, ...server } = a;
		(serversBySub.get(subscription_id) ?? serversBySub.set(subscription_id, []).get(subscription_id)).push(server);
	}

	const globalSubs = [];
	const byModality = new Map();
	const byProduct = new Map();
	for (const s of subs) {
		if (s.product_id) (byProduct.get(s.product_id) ?? byProduct.set(s.product_id, []).get(s.product_id)).push(s);
		else if (s.modality_id) (byModality.get(s.modality_id) ?? byModality.set(s.modality_id, []).get(s.modality_id)).push(s);
		else globalSubs.push(s);
	}

	const toSpool = (s) => {
		const servers = serversBySub.get(s.id) ?? [];
		if (servers.length === 0) return null;
		return { name: s.name, pattern: s.pattern, negate: s.negate, servers };
	};

	const desired = new Set();
	let written = 0;
	let deleted = 0;
	for (const p of products) {
		const applicable = [
			...globalSubs,
			...(byModality.get(p.modality_id) ?? []),
			...(byProduct.get(p.id) ?? []),
		];
		const seen = new Set();
		const spool = [];
		for (const s of applicable) {
			if (seen.has(s.id)) continue;
			seen.add(s.id);
			const item = toSpool(s);
			if (item) spool.push(item);
		}
		const key = subsKey(p.modality_name, p.product_name);
		if (spool.length === 0) {
			deleted += await redis.del(key);
			continue;
		}
		spool.sort((a, b) => a.name.localeCompare(b.name));
		desired.add(key);
		const hash = {};
		for (const s of spool) hash[s.name] = JSON.stringify({ pattern: s.pattern, negate: s.negate, servers: s.servers });
		await redis.del(key);
		await redis.hSet(key, hash);
		written++;
	}

	const stale = (await scanKeys('ftp_subscriptions:*')).filter((k) => !desired.has(k));
	const CHUNK = 500;
	for (let i = 0; i < stale.length; i += CHUNK) {
		await Promise.all(stale.slice(i, i + CHUNK).map((k) => redis.unlink(k)));
	}
	deleted += stale.length;

	console.log(`spooled ${written} product subscription sets`
		+ (deleted ? `; removed ${deleted} empty/stale keys` : ''));
	await redis.quit();
	await sql.end();
}

main().catch(async (e) => {
	console.error(e);
	try { await redis.quit(); } catch {}
	try { await sql.end(); } catch {}
	process.exit(1);
});
