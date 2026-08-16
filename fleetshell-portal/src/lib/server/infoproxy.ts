// src/lib/server/infoproxy.ts
//
// Info Proxy runtime spooler. Flattens the master data
//   binding -> collection -> rule
// into a per-source-IP allow-list in Valkey so the Squid external_acl_type
// helper can authorize a proxy request with an O(1) lookup on the CLIENT IP
// (the only stable identity Squid sees at request time). Device modality /
// product / serial is resolved OFFLINE here, at spool time, via
//   device.ip_address -> device -> product model -> matching bindings.
//
// See docs/product_admin.md section 4 + docs/mdm_status.md (Infoproxy spool).
//
// Two Squids -- INTRANET and INTERNET -- are independent, so keys are namespaced
// by proxy_type. A source IP therefore has (at most) two keys, one per proxy.
//
// Valkey key layout:
//
//   SET  infoproxy:<proxy_type>:<source_ip>   members = allowed destinations
//
//        proxy_type = 'intranet' | 'internet'
//        source_ip  = device.ip_address (the Squid client IP)
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
// A request is ALLOWED iff any member of the client's SET matches the
// destination + port. Absence of the key => no rules => DENY (default deny).
//
// Each source-IP key is rewritten atomically (single-key DEL + SADD => same
// cluster slot); stale keys (IPs no longer present) are UNLINKed. No hash tag
// is needed -- the helper never does cross-key ops.

import { createClient } from 'redis';
import { env } from '$env/dynamic/private';
import { globalDb } from './db';

export type ProxyType = 'intranet' | 'internet';

/** Valkey key for one client IP under one proxy. */
export const infoproxyKey = (proxyType: string, ip: string) => `infoproxy:${proxyType}:${ip}`;

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

type ResolvedRow = {
	proxy_type: string;
	ip_address: string;
	dns: string | null;
	cidr: string | null;
	port_from: number | null;
	port_to: number | null;
	protocol: string | null;
};

/**
 * Resolve every device with an IP to its effective proxy allow-list, per proxy
 * type. Returns proxy_type -> (source_ip -> SET of encoded members). Members are
 * deduped by the SET; a device sharing an IP with another simply unions its rules.
 *
 * Matching (see migrate_infoproxy.sql): a binding applies to a device when
 *   (device_id IS NULL OR device_id = D) AND (product_id IS NULL OR product_id = D's model).
 * D's model product id = the product node whose path equals device.product_path.
 */
export async function resolveAllowlists(): Promise<Map<string, Map<string, Set<string>>>> {
	const rows = await globalDb<ResolvedRow[]>`
		SELECT c.proxy_type,
		       d.ip_address,
		       r.target_dns              AS dns,
		       r.target_cidr::text       AS cidr,
		       r.target_port_from        AS port_from,
		       r.target_port_to          AS port_to,
		       r.protocol
		FROM device d
		LEFT JOIN product m ON m.path = d.product_path        -- d's model node
		JOIN proxy_destination_binding b
		  ON (b.device_id IS NULL OR b.device_id = d.id)
		 AND (b.product_id IS NULL OR b.product_id = m.id)
		JOIN proxy_destination_rule_collection c ON c.id = b.collection_id
		JOIN proxy_destination_rule r            ON r.collection_id = c.id
		WHERE d.ip_address IS NOT NULL AND d.ip_address <> ''`;

	const out = new Map<string, Map<string, Set<string>>>();
	for (const row of rows) {
		let byIp = out.get(row.proxy_type);
		if (!byIp) out.set(row.proxy_type, (byIp = new Map()));
		let set = byIp.get(row.ip_address);
		if (!set) byIp.set(row.ip_address, (set = new Set()));
		set.add(encodeRule(row));
	}
	return out;
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
 * any key whose source IP no longer resolves to a rule. Each source-IP key is
 * rewritten with a single-key DEL + SADD (same slot); stale keys are UNLINKed.
 * Returns per-proxy write counts + the number of stale keys removed.
 */
export async function syncToValkey(): Promise<{ written: number; removed: number; byType: Record<string, number> }> {
	const resolved = await resolveAllowlists();
	const client = await valkey();

	// Desired key set (so we can prune stale keys afterwards).
	const desired = new Set<string>();
	const byType: Record<string, number> = {};
	let written = 0;
	for (const [proxyType, byIp] of resolved) {
		for (const [ip, members] of byIp) {
			const key = infoproxyKey(proxyType, ip);
			desired.add(key);
			const multi = client.multi();
			multi.del(key);
			multi.sAdd(key, [...members]);
			await multi.exec();
			written++;
			byType[proxyType] = (byType[proxyType] ?? 0) + 1;
		}
	}

	// Prune stale keys (IPs/proxies no longer present).
	const stale: string[] = [];
	for await (const batch of client.scanIterator({ MATCH: 'infoproxy:*', COUNT: 1000 })) {
		for (const k of Array.isArray(batch) ? batch : [batch]) if (!desired.has(k)) stale.push(k);
	}
	const CHUNK = 500;
	for (let i = 0; i < stale.length; i += CHUNK) {
		await Promise.all(stale.slice(i, i + CHUNK).map((k) => client.unlink(k)));
	}

	return { written, removed: stale.length, byType };
}
