// src/lib/server/subscriptions.ts
//
// File Subscriptions runtime spooler. Resolves, per device product, the set of
// file-matcher subscriptions and their delivery targets, and writes them to
// Valkey for aeroftp -- mirroring the classification feature's per-product hash
// (`data_classes:<MODALITY>:<PRODUCT>`) that aeroftp already consumes.
//
// See migrate_file_subscriptions.sql + docs/mdm_status.md.
//
// A subscription is a file matcher (optional modality / product narrowing, a
// PCRE `pattern`, and a `negate` exclusion flag) attached to N delivery targets
// (subscriber servers). aeroftp runs on/for a device, knows its modality/product
// and its filenames, and needs: which subscriptions apply to my product, and for
// each, where to deliver a matched file.
//
// Valkey key layout (product-keyed, like data_classes):
//
//   HASH  ftp_subscriptions:<MODALITY>:<PRODUCT>
//         field = subscription name
//         value = JSON { pattern, negate, servers: [ <server>, ... ] }
//
// where <server> is the DENORMALIZED delivery target (so aeroftp needs a single
// key lookup; secrets are embedded PLAINTEXT, matching the subscriber_server.auth
// + gateway-PSK precedent):
//
//   { id, name, activated, delivery_method, host, country, use_case,
//     root_path, use_partno_folder, container_path, auth }
//
// NOTE on `activated`: a DEACTIVATED server is NOT skipped here. Jobs must still
// be enqueued for it while it is down (e.g. under maintenance) so that, once it
// is reactivated, the backlog that accumulated during the outage is delivered.
// The subscription-handler fleet enqueues a job for EVERY matching server but
// only *processes* jobs for activated ones -- so the spool carries `activated`
// as data, and never drops a target on it. See docs/file_subscriptions.md.
//
// Resolution (which subscriptions apply to a product P in modality M):
//   * global      : modality_id IS NULL AND product_id IS NULL
//   * modality-wide: modality_id = M    AND product_id IS NULL
//   * product     : product_id = P
// A subscription with NO attached server is dropped (nothing to deliver). A
// product with no applicable subscription gets its key deleted.

import { createClient } from 'redis';
import { env } from '$env/dynamic/private';
import { globalDb } from './db';

export type SpoolServer = {
	id: string;
	name: string;
	/** false = server is down/not-yet-live; jobs are still enqueued (backlog). */
	activated: boolean;
	delivery_method: string;
	host: string | null;
	country: string | null;
	use_case: string;
	root_path: string | null;
	use_partno_folder: boolean;
	container_path: string | null;
	auth: unknown;
};

export type SpoolSub = { name: string; pattern: string; negate: boolean; servers: SpoolServer[] };

export type ResolvedProduct = {
	modalityName: string;
	productName: string;
	subs: SpoolSub[];
};

type ProductRow = { id: string; product_name: string; modality_id: string; modality_name: string };
type SubRow = { id: string; name: string; pattern: string; negate: boolean; modality_id: string | null; product_id: string | null };
type AttachRow = SpoolServer & { subscription_id: string };

/**
 * Resolve every product to its effective subscription list (with denormalized,
 * activated delivery targets). Products with no effective subscription are still
 * returned (empty `subs`) so the caller can delete stale keys.
 */
export async function resolveSubscriptions(): Promise<ResolvedProduct[]> {
	// Every product with its modality ancestor.
	const products = await globalDb<ProductRow[]>`
		SELECT p.id::text AS id, p.name AS product_name,
		       m.id::text AS modality_id, m.name AS modality_name
		FROM product p
		JOIN product m ON m.kind = 'modality' AND p.path <@ m.path
		WHERE p.kind = 'product'
		ORDER BY m.name, p.name`;

	const subs = await globalDb<SubRow[]>`
		SELECT id::text AS id, name, pattern, negate,
		       modality_id::text AS modality_id, product_id::text AS product_id
		FROM subscription`;

	// Attached delivery targets per subscription. ALL attached servers are
	// emitted (activated or not) -- see the `activated` note in the header: a
	// deactivated server still needs jobs enqueued so its downtime backlog is
	// delivered once it comes back online.
	const attachments = await globalDb<AttachRow[]>`
		SELECT ss.subscription_id::text AS subscription_id,
		       s.id::text AS id, s.name, s.activated, s.delivery_method, s.ip_address AS host,
		       s.country, s.use_case, s.root_path, s.use_partno_folder,
		       s.container_path, s.auth
		FROM subscription_server ss
		JOIN subscriber_server s ON s.id = ss.server_id
		ORDER BY s.name`;

	const serversBySub = new Map<string, SpoolServer[]>();
	for (const a of attachments) {
		const { subscription_id, ...server } = a;
		(serversBySub.get(subscription_id) ?? serversBySub.set(subscription_id, []).get(subscription_id)!).push(server);
	}

	// Index subscriptions for O(1) applicability lookups.
	const globalSubs: SubRow[] = [];
	const byModality = new Map<string, SubRow[]>();
	const byProduct = new Map<string, SubRow[]>();
	for (const s of subs) {
		if (s.product_id) (byProduct.get(s.product_id) ?? byProduct.set(s.product_id, []).get(s.product_id)!).push(s);
		else if (s.modality_id) (byModality.get(s.modality_id) ?? byModality.set(s.modality_id, []).get(s.modality_id)!).push(s);
		else globalSubs.push(s);
	}

	const toSpool = (s: SubRow): SpoolSub | null => {
		const servers = serversBySub.get(s.id) ?? [];
		if (servers.length === 0) return null;           // no attached target -> nothing to deliver
		return { name: s.name, pattern: s.pattern, negate: s.negate, servers };
	};

	return products.map((p) => {
		const applicable = [
			...globalSubs,
			...(byModality.get(p.modality_id) ?? []),
			...(byProduct.get(p.id) ?? []),
		];
		const seen = new Set<string>();
		const spool: SpoolSub[] = [];
		for (const s of applicable) {
			if (seen.has(s.id)) continue;
			seen.add(s.id);
			const item = toSpool(s);
			if (item) spool.push(item);
		}
		spool.sort((a, b) => a.name.localeCompare(b.name));
		return { modalityName: p.modality_name, productName: p.product_name, subs: spool };
	});
}

// --- Valkey ------------------------------------------------------------------
//
// Single-node client (same rationale as classification.ts / infoproxy.ts).

let _client: ReturnType<typeof createClient> | undefined;
async function valkey() {
	if (_client?.isReady) return _client;
	const url = env.VALKEY_URL ?? 'rediss://localhost:6380';
	const rejectUnauthorized = env.VALKEY_TLS_REJECT_UNAUTHORIZED !== 'false';
	_client = createClient({
		url,
		socket: url.startsWith('rediss://') ? { tls: true, rejectUnauthorized } : undefined,
	});
	_client.on('error', (err: Error) => console.error('[valkey] subscriptions client error:', err.message));
	await _client.connect();
	return _client;
}

/** Valkey key for one product's subscription hash. */
export const subsKey = (modality: string, product: string) => `ftp_subscriptions:${modality}:${product}`;

/**
 * Authoritative full spool: rewrite every ftp_subscriptions:* key from the DB.
 * Each product key is rewritten from scratch (DEL then HSET); products that
 * resolve to nothing get their key deleted, and stale keys (products removed /
 * renamed) are pruned. Returns per-key counts.
 */
export async function syncToValkey(): Promise<{ written: number; deleted: number }> {
	const products = await resolveSubscriptions();
	const client = await valkey();

	const desired = new Set<string>();
	let written = 0;
	let deleted = 0;
	for (const p of products) {
		const key = subsKey(p.modalityName, p.productName);
		if (p.subs.length === 0) {
			deleted += await client.del(key);
			continue;
		}
		desired.add(key);
		const hash: Record<string, string> = {};
		for (const s of p.subs) {
			hash[s.name] = JSON.stringify({ pattern: s.pattern, negate: s.negate, servers: s.servers });
		}
		await client.del(key);
		await client.hSet(key, hash);
		written += 1;
	}

	// Prune stale keys not in the desired set.
	const stale: string[] = [];
	for await (const batch of client.scanIterator({ MATCH: 'ftp_subscriptions:*', COUNT: 1000 })) {
		for (const k of Array.isArray(batch) ? batch : [batch]) if (!desired.has(k)) stale.push(k);
	}
	const CHUNK = 500;
	for (let i = 0; i < stale.length; i += CHUNK) {
		const slice = stale.slice(i, i + CHUNK);
		await Promise.all(slice.map((k) => client.unlink(k)));
		deleted += slice.length;
	}

	return { written, deleted };
}
