// src/lib/server/classification.ts
//
// Data-classification resolver + Valkey sync. Rule Sets and Assignments (both
// modality-owned) resolve into the per-product Valkey hash
//   data_classes:<MODALITY>:<PRODUCT>
// where each field is a slash-delimited filename regex and the value is the
// comma-joined union of data-class codes. See docs/data_classification.md.

import { createClient } from 'redis';
import { env } from '$env/dynamic/private';
import { globalDb } from '$lib/server/db';

// Canonical class order (matches data_class.sort_order) for deterministic output.
export const CLASS_ORDER = ['PHI', 'UPD', 'RD', 'PII', 'ACD', 'DSH', 'TSD', 'STD'];

export type ResolvedProduct = {
	productId: string;
	productName: string;
	family: string | null;
	/** regex (without slashes) -> ordered class codes. */
	fields: { regex: string; codes: string[] }[];
};

type RuleRow = { set_id: string; regex: string; codes: string[] };
type AssignRow = { set_id: string; product_id: string | null; family: string | null };
type ProductRow = { id: string; name: string; family: string | null };

function orderCodes(codes: Iterable<string>): string[] {
	const set = new Set(codes);
	return CLASS_ORDER.filter((c) => set.has(c));
}

/**
 * Resolve every product in a modality to its effective, merged rule list --
 * exactly what will be written to Valkey. Products with no effective rules are
 * still returned (empty `fields`) so the caller can delete stale keys.
 */
export async function resolveModality(modalityId: string): Promise<{
	modalityName: string;
	products: ResolvedProduct[];
}> {
	const [mod] = await globalDb<{ name: string; path: string }[]>`
		SELECT name, path::text AS path FROM product WHERE id = ${modalityId} AND kind = 'modality'`;
	if (!mod) return { modalityName: '', products: [] };

	const products = await globalDb<ProductRow[]>`
		SELECT id::text AS id, name, family
		FROM product
		WHERE kind = 'product' AND path <@ ${mod.path}::ltree
		ORDER BY name`;

	const rules = await globalDb<RuleRow[]>`
		SELECT r.set_id::text AS set_id, r.regex,
		       COALESCE(array_agg(rc.code) FILTER (WHERE rc.code IS NOT NULL), '{}') AS codes
		FROM classification_set s
		JOIN classification_rule r ON r.set_id = s.id
		LEFT JOIN classification_rule_class rc ON rc.rule_id = r.id
		WHERE s.modality_id = ${modalityId}
		GROUP BY r.id, r.set_id, r.regex, r.sort_order
		ORDER BY r.sort_order`;

	const assigns = await globalDb<AssignRow[]>`
		SELECT a.set_id::text AS set_id, a.product_id::text AS product_id, a.family
		FROM classification_assignment a
		JOIN classification_set s ON s.id = a.set_id
		WHERE s.modality_id = ${modalityId}`;

	// Index rules by set.
	const rulesBySet = new Map<string, RuleRow[]>();
	for (const r of rules) {
		const arr = rulesBySet.get(r.set_id) ?? [];
		arr.push(r);
		rulesBySet.set(r.set_id, arr);
	}

	// For each product, collect the set ids assigned to it (direct / family / modality-wide).
	const modalityWideSets = new Set<string>();
	const setsByProduct = new Map<string, Set<string>>();
	const setsByFamily = new Map<string, Set<string>>();
	for (const a of assigns) {
		if (a.product_id) {
			const s = setsByProduct.get(a.product_id) ?? new Set();
			s.add(a.set_id);
			setsByProduct.set(a.product_id, s);
		} else if (a.family) {
			const s = setsByFamily.get(a.family) ?? new Set();
			s.add(a.set_id);
			setsByFamily.set(a.family, s);
		} else {
			modalityWideSets.add(a.set_id);
		}
	}

	const resolved: ResolvedProduct[] = products.map((p) => {
		const setIds = new Set<string>(modalityWideSets);
		for (const id of setsByProduct.get(p.id) ?? []) setIds.add(id);
		if (p.family) for (const id of setsByFamily.get(p.family) ?? []) setIds.add(id);

		// Merge rules across all effective sets; union codes per regex.
		const byRegex = new Map<string, Set<string>>();
		for (const setId of setIds) {
			for (const r of rulesBySet.get(setId) ?? []) {
				const acc = byRegex.get(r.regex) ?? new Set<string>();
				for (const c of r.codes) acc.add(c);
				byRegex.set(r.regex, acc);
			}
		}
		const fields = [...byRegex.entries()]
			.map(([regex, codes]) => ({ regex, codes: orderCodes(codes) }))
			.sort((a, b) => a.regex.localeCompare(b.regex));
		return { productId: p.id, productName: p.name, family: p.family, fields };
	});

	return { modalityName: mod.name, products: resolved };
}

// NOTE: single-node client. The dev Valkey is a single-node cluster (per-key
// commands work; only multi-key CROSSSLOT ops are rejected, which we never use).
// A true multi-node cluster would need createCluster() here.
let _client: ReturnType<typeof createClient> | undefined;

async function valkey() {
	if (_client?.isReady) return _client;
	const url = env.VALKEY_URL ?? 'rediss://localhost:6380';
	const rejectUnauthorized = env.VALKEY_TLS_REJECT_UNAUTHORIZED !== 'false';
	_client = createClient({
		url,
		socket: url.startsWith('rediss://') ? { tls: true, rejectUnauthorized } : undefined,
	});
	_client.on('error', (err: Error) => console.error('[valkey] client error:', err.message));
	await _client.connect();
	return _client;
}

/**
 * Write a whole modality's resolved classification into Valkey. Each product key
 * is rewritten from scratch (DEL then HSET); products that resolve to nothing get
 * their key deleted. Returns per-key counts.
 */
export async function syncModalityToValkey(modalityId: string): Promise<{
	modalityName: string;
	written: number;
	deleted: number;
}> {
	const { modalityName, products } = await resolveModality(modalityId);
	if (!modalityName) return { modalityName: '', written: 0, deleted: 0 };
	const client = await valkey();

	let written = 0;
	let deleted = 0;
	for (const p of products) {
		const key = `data_classes:${modalityName}:${p.productName}`;
		if (p.fields.length === 0) {
			const n = await client.del(key);
			deleted += n;
			continue;
		}
		const hash: Record<string, string> = {};
		for (const f of p.fields) hash[`/${f.regex}/`] = f.codes.join(',');
		await client.del(key);
		await client.hSet(key, hash);
		written += 1;
	}
	return { modalityName, written, deleted };
}
