// src/lib/server/infoproxy.ts
//
// Info Proxy runtime spooler. Flattens the master data
//   binding -> collection -> rule
// into SCOPE-TIERED allow-lists in Valkey so the Squid external_acl_type helper
// can authorize a proxy request by unioning the tiers that apply to the client.
// Device modality / product / serial is resolved OFFLINE (here at spool time,
// and at request time via the shared device hash).
//
// Two Squids -- INTRANET and INTERNET -- are independent, so keys are namespaced
// by proxy_type. Within a proxy_type there are three SCOPE tiers, mirroring the
// binding scope (see migrate_infoproxy.sql):
//
//   SET  infoproxy:<proxy_type>:global            ANY/ANY bindings (every device)
//   SET  infoproxy:<proxy_type>:model:<partno>    bindings scoped to a model
//   SET  infoproxy:<proxy_type>:device:<ip>       device-specific bindings
//
//        proxy_type = 'intranet' | 'internet'
//        partno     = product_model.partno  (one partno == one model; this is
//                     the SAME value already in systems:by-ip:<ip>.partno, so
//                     the helper resolves a client's model with one HGET)
//        ip         = device.ip_address (the Squid client IP)
//
// WHY TIERED (not one flattened per-IP set): a fully denormalized per-device
// set makes every global-rule edit re-spool the whole fleet (~192k x 2 keys),
// and couples device provisioning to an infoproxy re-spool. Tiering makes each
// master-data change O(1): a global URL edit rewrites ONE key; a model edit one
// key per partno; a device override one key. Adding or moving a device needs NO
// infoproxy spool at all -- its systems:by-ip hash already routes it to the
// shared global + model keys.
//
// Each SET member is a TAB-delimited destination tuple the helper matches:
//
//   <dns>\t<cidr>\t<port_from>\t<port_to>\t<protocol>
//
//   dns        destination host/domain (empty = match by cidr only)
//   cidr       IP or range in CIDR text, e.g. 10.0.0.0/8 or 1.2.3.4/32
//              (empty = match by dns only)
//   port_from  lower bound (empty = any port)
//   port_to    upper bound (= port_from for a single port; empty = any)
//   protocol   freeform legacy label, e.g. 'CONNECT / HTTPS' (advisory)
//
// A request is ALLOWED iff any member of any applicable tier matches. Each key
// is rewritten atomically (single-key DEL + SADD => same cluster slot); stale
// keys are UNLINKed. No hash tag is needed -- the helper never does cross-key
// ops (it issues separate SMEMBERS per tier and unions in-process).

import { createClient } from 'redis';
import { env } from '$env/dynamic/private';
import { globalDb } from './db';

export type ProxyType = 'intranet' | 'internet';

/** Valkey keys, one builder per scope tier. */
export const infoproxyGlobalKey = (proxyType: string) => `infoproxy:${proxyType}:global`;
export const infoproxyModelKey = (proxyType: string, partno: string) =>
	`infoproxy:${proxyType}:model:${partno}`;
export const infoproxyDeviceKey = (proxyType: string, ip: string) =>
	`infoproxy:${proxyType}:device:${ip}`;

/** Field separator inside a SET member (values never contain a tab). */
const SEP = '\t';

/** Encode one destination rule into a stable SET member. */
export function encodeRule(r: {
	dns: string | null;
	cidr: string | null;
	port_from: number | null;
	port_to: number | null;
	protocol: string | null;
}): string {
	return [
		r.dns ?? '',
		r.cidr ?? '',
		r.port_from == null ? '' : String(r.port_from),
		r.port_to == null ? '' : String(r.port_to),
		r.protocol ?? '',
	].join(SEP);
}

type RuleCols = {
	dns: string | null;
	cidr: string | null;
	port_from: number | null;
	port_to: number | null;
	protocol: string | null;
};

type RuleRow = RuleCols & { proxy_type: string };
type ModelRuleRow = RuleRow & { partno: string };
type DeviceRuleRow = RuleRow & { ip_address: string };

/** One progress tick emitted while spooling (for the SSE progress stream). */
export type SpoolProgress = {
	phase: 'count' | 'global' | 'model' | 'device' | 'prune' | 'done';
	/** Keys written so far (or, for `prune`, keys removed so far). */
	done: number;
	/** Total keys to write (known after the `count` phase; 0 before). */
	total: number;
	/** The key just written/removed, when applicable. */
	key?: string;
};
export type ProgressFn = (p: SpoolProgress) => void;

/**
 * Rows streamed per network round-trip while walking a tier. postgres.js holds
 * only this many rows in memory at once (plus the current scope's member set),
 * so the whole fleet never materialises in the Node heap -- the old
 * `resolveTiers()` buffered every binding x rule row of all three tiers before
 * writing a single key, which OOM-killed the container.
 */
const CURSOR_BATCH = 2000;

/**
 * How many per-key MULTI/EXEC transactions to pipeline before awaiting them as a
 * batch. Bounds in-flight memory (the buffered member arrays) while collapsing
 * thousands of sequential round-trips into a few socket flushes.
 */
const PIPELINE_KEYS = 256;

/**
 * Count the exact number of tier keys the spool will write, so progress can be
 * reported as `done / total`. Each COUNT(DISTINCT ...) runs entirely in the DB
 * (a single aggregate; the binding x rule fan-out never crosses the wire), and
 * mirrors the streamed queries' filters -- including the INNER JOIN to
 * `proxy_destination_rule`, so a binding to an empty collection (which produces
 * no key) is not counted.
 */
async function countKeys(): Promise<number> {
	const [g] = await globalDb<{ n: number }[]>`
		SELECT COUNT(DISTINCT c.proxy_type)::int AS n
		FROM proxy_destination_binding b
		JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
		JOIN proxy_destination_rule r            ON r.collection_id = c.id
		WHERE b.device_id IS NULL AND b.product_id IS NULL`;
	const [m] = await globalDb<{ n: number }[]>`
		SELECT COUNT(*)::int AS n FROM (
			SELECT DISTINCT c.proxy_type, pm.partno
			FROM proxy_destination_binding b
			JOIN product_model pm                    ON pm.product_id = b.product_id
			JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
			JOIN proxy_destination_rule r            ON r.collection_id = c.id
			WHERE b.product_id IS NOT NULL AND b.device_id IS NULL AND pm.partno IS NOT NULL
		) t`;
	const [d] = await globalDb<{ n: number }[]>`
		SELECT COUNT(*)::int AS n FROM (
			SELECT DISTINCT c.proxy_type, d.ip_address
			FROM proxy_destination_binding b
			JOIN device d                            ON d.id = b.device_id
			LEFT JOIN product mp                     ON mp.path = d.product_path
			JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
			JOIN proxy_destination_rule r            ON r.collection_id = c.id
			WHERE b.device_id IS NOT NULL AND (b.product_id IS NULL OR b.product_id = mp.id)
			  AND d.ip_address IS NOT NULL AND d.ip_address <> ''
		) t`;
	return (g?.n ?? 0) + (m?.n ?? 0) + (d?.n ?? 0);
}

/**
 * Walk a scoped tier's rows (streamed, ordered by `proxy_type, scope`) and write
 * one Valkey key per scope. Because the rows arrive grouped by scope, only the
 * current scope's member set is buffered: on a scope boundary the accumulated
 * set is flushed and released. `writeKey` records the key in `desired` (for
 * pruning) and bumps counters; `onProgress` is fired per flushed key.
 */
async function streamScoped<R extends RuleRow>(
	rows: AsyncIterable<R[]>,
	scopeOf: (r: R) => string,
	keyFor: (proxyType: string, scope: string) => string,
	phase: 'model' | 'device',
	writeKey: (key: string, proxyType: string, members: Set<string>) => Promise<void>,
	total: number,
	writtenSoFar: () => number,
	onProgress?: ProgressFn,
): Promise<void> {
	let curType: string | null = null;
	let curScope: string | null = null;
	let members = new Set<string>();

	const flush = async () => {
		if (curType === null || curScope === null) return;
		const key = keyFor(curType, curScope);
		await writeKey(key, curType, members);
		onProgress?.({ phase, done: writtenSoFar(), total, key });
		members = new Set();
	};

	for await (const batch of rows) {
		for (const r of batch) {
			const scope = scopeOf(r);
			if (r.proxy_type !== curType || scope !== curScope) {
				await flush();
				curType = r.proxy_type;
				curScope = scope;
			}
			members.add(encodeRule(r));
		}
	}
	await flush();
}

// --- Valkey ------------------------------------------------------------------
//
// Single-node client (the dev Valkey is a single-node cluster: per-key commands
// work; only multi-key CROSSSLOT ops are rejected, which we never issue). A true
// multi-node cluster would need createCluster() here.

let _client: ReturnType<typeof createClient> | undefined;
async function valkey() {
	if (_client?.isReady) return _client;
	const url = env.VALKEY_URL ?? 'rediss://localhost:6380';
	const rejectUnauthorized = env.VALKEY_TLS_REJECT_UNAUTHORIZED !== 'false';
	_client = createClient({
		url,
		socket: url.startsWith('rediss://') ? { tls: true, rejectUnauthorized } : undefined,
	});
	_client.on('error', (err: Error) => console.error('[valkey] infoproxy client error:', err.message));
	await _client.connect();
	return _client;
}

/**
 * Authoritative full spool: rewrite every infoproxy:* key from the DB and drop
 * any key that no longer resolves. Each key is rewritten with a single-key
 * DEL + SADD (same slot); stale keys are UNLINKed. This also prunes any legacy
 * flat per-IP keys (`infoproxy:<pt>:<ip>`) from the pre-tiered layout, since
 * they are not in the desired set.
 *
 * The master data is STREAMED tier by tier via server-side cursors and each key
 * is written as soon as its scope's rows have been read, so peak memory is one
 * cursor batch + one scope's member set -- not the whole fleet (which OOM-killed
 * the container in the old materialise-everything design). Pass `onProgress` to
 * receive per-key ticks for a progress bar.
 *
 * Writes are PIPELINED: each key is still its own atomic MULTI/EXEC (DEL + SADD,
 * so a concurrent Squid lookup never sees a half-rewritten key), but up to
 * PIPELINE_KEYS of those transactions are dispatched without an intervening
 * await, so node-redis flushes them to the socket in one batch. That turns the
 * old ~one-round-trip-per-key cost (2000+ sequential RTTs) into a handful of
 * pipeline flushes.
 */
export async function syncToValkey(onProgress?: ProgressFn): Promise<{
	written: number;
	removed: number;
	byType: Record<string, number>;
}> {
	const client = await valkey();

	const desired = new Set<string>();
	const byType: Record<string, number> = {};
	let written = 0;

	// Pending pipelined transactions (one exec() promise per key). Flushed in
	// bounded batches so memory and error surfacing stay predictable.
	let pending: Promise<unknown>[] = [];
	const flushPending = async () => {
		if (pending.length === 0) return;
		const batch = pending;
		pending = [];
		await Promise.all(batch);
	};

	const writeKey = async (key: string, proxyType: string, members: Set<string>) => {
		desired.add(key);
		// One atomic transaction per key; issued WITHOUT awaiting so node-redis
		// pipelines it with its neighbours. DEL+SADD in a MULTI keeps the key from
		// ever being observed empty mid-rewrite.
		const multi = client.multi();
		multi.del(key);
		if (members.size) multi.sAdd(key, [...members]);
		pending.push(multi.exec());
		written++;
		byType[proxyType] = (byType[proxyType] ?? 0) + 1;
		if (pending.length >= PIPELINE_KEYS) await flushPending();
	};

	// -- how many keys total (for progress) --------------------------------------
	onProgress?.({ phase: 'count', done: 0, total: 0 });
	const total = await countKeys();

	// -- global tier: ANY device, ANY model (tiny -- accumulate then write) -------
	const globalRows = await globalDb<RuleRow[]>`
		SELECT c.proxy_type,
		       r.target_dns AS dns, r.target_cidr::text AS cidr,
		       r.target_port_from AS port_from, r.target_port_to AS port_to, r.protocol
		FROM proxy_destination_binding b
		JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
		JOIN proxy_destination_rule r            ON r.collection_id = c.id
		WHERE b.device_id IS NULL AND b.product_id IS NULL`;
	const globalByType = new Map<string, Set<string>>();
	for (const row of globalRows) {
		let set = globalByType.get(row.proxy_type);
		if (!set) globalByType.set(row.proxy_type, (set = new Set()));
		set.add(encodeRule(row));
	}
	for (const [proxyType, members] of globalByType) {
		const key = infoproxyGlobalKey(proxyType);
		await writeKey(key, proxyType, members);
		onProgress?.({ phase: 'global', done: written, total, key });
	}

	// -- model tier: scoped to a model, keyed by partno (streamed) ----------------
	// One model may have several partnos (variants); a rule is emitted under each
	// so a device of any of those partnos matches. Ordered by (proxy_type, partno)
	// so all rows of a scope arrive contiguously.
	await streamScoped<ModelRuleRow>(
		globalDb<ModelRuleRow[]>`
			SELECT c.proxy_type, pm.partno::text AS partno,
			       r.target_dns AS dns, r.target_cidr::text AS cidr,
			       r.target_port_from AS port_from, r.target_port_to AS port_to, r.protocol
			FROM proxy_destination_binding b
			JOIN product_model pm                    ON pm.product_id = b.product_id
			JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
			JOIN proxy_destination_rule r            ON r.collection_id = c.id
			WHERE b.product_id IS NOT NULL AND b.device_id IS NULL AND pm.partno IS NOT NULL
			ORDER BY c.proxy_type, pm.partno`.cursor(CURSOR_BATCH),
		(r) => r.partno,
		infoproxyModelKey,
		'model', writeKey, total, () => written, onProgress,
	);

	// -- device tier: device-specific bindings, keyed by IP (streamed) -----------
	await streamScoped<DeviceRuleRow>(
		globalDb<DeviceRuleRow[]>`
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
		(r) => r.ip_address,
		infoproxyDeviceKey,
		'device', writeKey, total, () => written, onProgress,
	);

	// Flush any transactions still buffered from the last (partial) pipeline batch
	// before we scan for stale keys.
	await flushPending();

	// -- prune stale keys (scopes no longer present, and any legacy flat keys) ----
	const stale: string[] = [];
	for await (const batch of client.scanIterator({ MATCH: 'infoproxy:*', COUNT: 1000 })) {
		for (const k of Array.isArray(batch) ? batch : [batch]) if (!desired.has(k)) stale.push(k);
	}
	const CHUNK = 500;
	let pruned = 0;
	for (let i = 0; i < stale.length; i += CHUNK) {
		await Promise.all(stale.slice(i, i + CHUNK).map((k) => client.unlink(k)));
		pruned += Math.min(CHUNK, stale.length - i);
		onProgress?.({ phase: 'prune', done: pruned, total: stale.length });
	}

	onProgress?.({ phase: 'done', done: written, total });
	return { written, removed: stale.length, byType };
}
