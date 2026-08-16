// scripts/spool-dtm.mjs -- spool the Data Transfer Matrix into Valkey.
//
// Key format (hash-tagged so a whole FROM-country lives in ONE cluster slot):
//
//   SET  dtm:{<FROM>}:<TO>:<VARIANT>   members = denied data-class codes
//        ^^^^^^^^^^^^ hash tag -> all dtm:{DE}:* share a slot on MemoryDB.
//
// The `{FROM}` tag makes cross-key commands within one origin country legal on
// the (always cluster-mode) MemoryDB: we swap a country ATOMICALLY via one
// MULTI/EXEC (UNLINK the old keys + SADD the new) instead of thousands of
// single-key round-trips. aerosuite MUST build its lookup key with the same tag:
//   SISMEMBER dtm:{<from>}:<to>:<variant> <class>   -> member => DENY.
//
// Denial-list model: a MISSING key => fully permitted (default). This is the
// authoritative export: it drops origin countries no longer in the DB and swaps
// every present country atomically.
//
// Reads settings from the environment (or a local .env):
//   GLOBAL_DB_HOST/PORT/NAME/USER/PASSWORD, PGSSL, VALKEY_URL,
//   VALKEY_TLS_REJECT_UNAUTHORIZED.
//
// Run from the portal dir so postgres/redis resolve:
//   node scripts/spool-dtm.mjs

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

/** Valkey key for one (from, to, variant); {from} is the co-location hash tag. */
export const dtmKey = (from, to, variant) => `dtm:{${from}}:${to}:${variant}`;
/** Extract the FROM tag from a dtm key, or null. */
const tagOf = (key) => (key.match(/^dtm:\{([^}]*)\}:/)?.[1] ?? null);

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

	// All denials, grouped in the DB by (from,to,variant) -> [class_code,...].
	const rows = await sql`
		SELECT from_iso, to_iso, variant, array_agg(class_code ORDER BY class_code) AS codes
		FROM dtm_deny
		GROUP BY from_iso, to_iso, variant`;

	const byFrom = new Map();
	for (const r of rows) (byFrom.get(r.from_iso) ?? byFrom.set(r.from_iso, []).get(r.from_iso)).push(r);
	const present = new Set(byFrom.keys());

	// 1) Cleanup. Scan every dtm:* key and remove what should not survive:
	//    - untagged legacy keys (individually slotted) -> single-key UNLINK, pipelined;
	//    - keys for origin countries no longer in the DB -> one multi-key UNLINK per
	//      country (co-slot via the hash tag).
	const untagged = [];
	const staleByTag = new Map();
	for (const key of await scanKeys('dtm:*')) {
		const tag = tagOf(key);
		if (tag === null) untagged.push(key);
		else if (!present.has(tag)) (staleByTag.get(tag) ?? staleByTag.set(tag, []).get(tag)).push(key);
	}
	let dropped = 0;
	const CHUNK = 500;
	for (let i = 0; i < untagged.length; i += CHUNK) {
		await Promise.all(untagged.slice(i, i + CHUNK).map((k) => redis.unlink(k)));
	}
	dropped += untagged.length;
	for (const [, keys] of staleByTag) { await redis.unlink(keys); dropped += keys.length; }

	// 2) Atomic per-country swap: UNLINK the country's existing keys + SADD the
	//    new ones inside ONE MULTI/EXEC (all co-slot via the {from} tag).
	let written = 0;
	for (const [from, list] of byFrom) {
		const existing = await scanKeys(`dtm:{${from}}:*`);
		const multi = redis.multi();
		if (existing.length) multi.unlink(existing);
		for (const r of list) { multi.sAdd(dtmKey(from, r.to_iso, r.variant), r.codes); written++; }
		await multi.exec();
	}

	console.log(`spooled ${written} dtm keys across ${byFrom.size} origin countries`
		+ (dropped ? `; dropped ${dropped} stale keys` : ''));
	await redis.quit();
	await sql.end();
}

main().catch(async (e) => {
	console.error(e);
	try { await redis.quit(); } catch {}
	try { await sql.end(); } catch {}
	process.exit(1);
});
