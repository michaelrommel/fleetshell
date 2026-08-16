import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { syncToValkey } from '$lib/server/infoproxy';

// Info Proxy master data (Squid destination authorization). Phase 1: interim
// is_admin gate, like the rest of portal-dev.
async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

const orNull = (v: FormDataEntryValue | null): string | null => {
	const s = String(v ?? '').trim();
	return s === '' ? null : s;
};

type Coll = {
	id: string; name: string; proxy_type: string; rule_count: number;
	n_models: number; n_devices: number; has_any: boolean;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;

	const q = (url.searchParams.get('q') ?? '').trim();
	// proxy-type chips: default both on; a subset comes as ?types=internet or intranet
	const typesParam = url.searchParams.get('types');
	const types = typesParam === null
		? ['internet', 'intranet']
		: typesParam.split(',').filter((t) => t === 'internet' || t === 'intranet');
	const sel = url.searchParams.get('sel');
	const tab = (url.searchParams.get('tab') || 'dest') as 'dest' | 'scope';
	const isNew = isAdmin && url.searchParams.get('new') === '1';
	const productFilter = url.searchParams.get('product');   // deep-link: model node id

	const like = '%' + q + '%';
	const collections = types.length === 0 ? [] : await globalDb<Coll[]>`
		SELECT c.id::text AS id, c.name, c.proxy_type,
		  (SELECT count(*) FROM proxy_destination_rule r WHERE r.collection_id = c.id)::int AS rule_count,
		  (SELECT count(*) FROM proxy_destination_binding b WHERE b.collection_id = c.id AND b.product_id IS NOT NULL)::int AS n_models,
		  (SELECT count(*) FROM proxy_destination_binding b WHERE b.collection_id = c.id AND b.device_id IS NOT NULL)::int AS n_devices,
		  EXISTS (SELECT 1 FROM proxy_destination_binding b WHERE b.collection_id = c.id AND b.device_id IS NULL AND b.product_id IS NULL) AS has_any
		FROM proxy_destination_rule_collection c
		WHERE c.proxy_type = ANY(${types})
		  ${q ? globalDb`AND c.name ILIKE ${like}` : globalDb``}
		  ${productFilter ? globalDb`AND EXISTS (
			SELECT 1 FROM proxy_destination_binding b WHERE b.collection_id = c.id
			  AND (b.product_id = ${productFilter} OR (b.device_id IS NULL AND b.product_id IS NULL)))` : globalDb``}
		ORDER BY c.proxy_type, c.name`;

	let productFilterName: string | null = null;
	if (productFilter) {
		const [p] = await globalDb<{ name: string }[]>`SELECT name FROM product WHERE id = ${productFilter}`;
		productFilterName = p?.name ?? null;
	}

	// selected collection detail + tab payload
	let collection: Record<string, unknown> | null = null;
	let rules: Record<string, unknown>[] = [];
	let scope: { has_any: boolean; models: { key: string; label: string }[]; device_count: number } | null = null;
	if (sel) {
		[collection] = await globalDb<Record<string, unknown>[]>`
			SELECT id::text AS id, name, proxy_type, description
			FROM proxy_destination_rule_collection WHERE id = ${sel}`;
		if (collection) {
			if (tab === 'dest') {
				rules = await globalDb<Record<string, unknown>[]>`
					SELECT id::text AS id, host(target_cidr) AS cidr, target_dns AS dns,
					       target_port_from AS port_from, target_port_to AS port_to, protocol
					FROM proxy_destination_rule WHERE collection_id = ${sel}
					ORDER BY target_dns NULLS LAST, target_cidr NULLS LAST, target_port_from`;
			} else {
				const [{ has_any }] = await globalDb<{ has_any: boolean }[]>`
					SELECT EXISTS (SELECT 1 FROM proxy_destination_binding
						WHERE collection_id = ${sel} AND device_id IS NULL AND product_id IS NULL) AS has_any`;
				const models = await globalDb<{ key: string; label: string }[]>`
					SELECT p.id::text AS key, p.name AS label
					FROM proxy_destination_binding b JOIN product p ON p.id = b.product_id
					WHERE b.collection_id = ${sel} AND b.product_id IS NOT NULL
					ORDER BY p.name`;
				const [{ n }] = await globalDb<{ n: number }[]>`
					SELECT count(*)::int AS n FROM proxy_destination_binding
					WHERE collection_id = ${sel} AND device_id IS NOT NULL`;
				scope = { has_any, models, device_count: n };
			}
		}
	}

	return { isAdmin, q, types, sel, tab, isNew, productFilter, productFilterName,
		collections, collection, rules, scope };
};

function backTo(p: { sel?: string | null; tab?: string; types?: string[]; q?: string; product?: string | null }): string {
	const u = new URLSearchParams();
	if (p.q) u.set('q', p.q);
	if (p.types && !(p.types.length === 2)) u.set('types', p.types.join(','));
	if (p.product) u.set('product', p.product);
	if (p.sel) u.set('sel', p.sel);
	if (p.tab && p.tab !== 'dest') u.set('tab', p.tab);
	const qs = u.toString();
	return `${base}/services/infoproxy${qs ? '?' + qs : ''}`;
}

export const actions: Actions = {
	saveCollection: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		const name = orNull(d.get('name'));
		const proxyType = orNull(d.get('proxy_type')) ?? 'internet';
		const description = orNull(d.get('description'));
		if (!name) return fail(400, { error: 'Name is required.' });
		if (!['internet', 'intranet'].includes(proxyType)) return fail(400, { error: 'Bad proxy type.' });
		let newId = id;
		try {
			if (id) {
				await globalDb`UPDATE proxy_destination_rule_collection
					SET name = ${name}, proxy_type = ${proxyType}, description = ${description}
					WHERE id = ${id}`;
			} else {
				[{ id: newId }] = await globalDb<{ id: string }[]>`
					INSERT INTO proxy_destination_rule_collection (name, proxy_type, description)
					VALUES (${name}, ${proxyType}, ${description}) RETURNING id::text AS id`;
			}
		} catch {
			return fail(400, { error: 'A collection with that name already exists for this proxy.' });
		}
		throw redirect(303, backTo({ sel: newId }));
	},

	deleteCollection: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		if (!id) return fail(400, { error: 'Collection required.' });
		await globalDb`DELETE FROM proxy_destination_rule_collection WHERE id = ${id}`;
		throw redirect(303, backTo({}));
	},

	// Replace-all the collection's destination rules.
	saveRules: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		if (!id) return fail(400, { error: 'Collection required.' });
		let raw: unknown;
		try { raw = JSON.parse(String(d.get('rules') ?? '[]')); } catch { return fail(400, { error: 'Bad rule data.' }); }
		if (!Array.isArray(raw)) return fail(400, { error: 'Bad rule data.' });

		const rows: { cidr: string | null; dns: string | null; pf: number | null; pt: number | null; proto: string }[] = [];
		for (const r of raw as Record<string, unknown>[]) {
			const cidr = String(r.cidr ?? '').trim() || null;
			const dns = String(r.dns ?? '').trim() || null;
			if (!cidr && !dns) continue;               // needs a destination
			if (cidr && !/^[0-9.]+(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(cidr))
				return fail(400, { error: `Invalid IP/range: ${cidr}` });
			const pRaw = String(r.port ?? '').trim();
			const p = /^\d+$/.test(pRaw) ? Number(pRaw) : null;
			const proto = String(r.protocol ?? '').trim() || 'CONNECT / HTTPS';
			rows.push({ cidr, dns, pf: p, pt: p, proto });
		}
		try {
			await globalDb.begin(async (sql) => {
				await sql`DELETE FROM proxy_destination_rule WHERE collection_id = ${id}`;
				for (const r of rows) {
					await sql`INSERT INTO proxy_destination_rule
						(collection_id, target_cidr, target_dns, target_port_from, target_port_to, protocol)
						VALUES (${id}, ${r.cidr}::cidr, ${r.dns}, ${r.pf}, ${r.pt}, ${r.proto})`;
				}
			});
		} catch (e) {
			return fail(400, { error: `Could not save rules: ${(e as Error).message}` });
		}
		throw redirect(303, backTo({ sel: id, tab: 'dest' }));
	},

	// Toggle the single ANY/ANY (global) binding.
	toggleAny: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		if (!id) return fail(400, { error: 'Collection required.' });
		const on = d.get('on') === '1';
		if (on) {
			await globalDb`INSERT INTO proxy_destination_binding (collection_id, device_id, product_id)
				VALUES (${id}, NULL, NULL)`;
		} else {
			await globalDb`DELETE FROM proxy_destination_binding
				WHERE collection_id = ${id} AND device_id IS NULL AND product_id IS NULL`;
		}
		throw redirect(303, backTo({ sel: id, tab: 'scope' }));
	},

	// Replace-all the collection's model bindings (product_ids JSON).
	saveModels: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		if (!id) return fail(400, { error: 'Collection required.' });
		let ids: string[];
		try { ids = JSON.parse(String(d.get('product_ids') ?? '[]')); } catch { return fail(400, { error: 'Bad data.' }); }
		ids = [...new Set(ids.filter((v) => typeof v === 'string' && v))];
		await globalDb.begin(async (sql) => {
			await sql`DELETE FROM proxy_destination_binding WHERE collection_id = ${id} AND product_id IS NOT NULL`;
			for (const pid of ids) {
				await sql`INSERT INTO proxy_destination_binding (collection_id, product_id) VALUES (${id}, ${pid})`;
			}
		});
		throw redirect(303, backTo({ sel: id, tab: 'scope' }));
	},

	// Spool the resolved proxy authorization to Valkey for the Squid external_acl
	// helper: flatten binding -> collection -> rule into a per-source-IP allow-list
	// (per proxy_type). See src/lib/server/infoproxy.ts.
	spoolValkey: async ({ locals }) => {
		await requireAdmin(locals);
		try {
			const { written, removed, byType } = await syncToValkey();
			const parts = Object.entries(byType).map(([t, n]) => `${n} ${t}`);
			const detail = parts.length ? ` (${parts.join(', ')})` : '';
			return { notice: `Spooled ${written} source-IP allow-lists${detail}`
				+ (removed ? `; removed ${removed} stale.` : '.') };
		} catch (e) {
			return fail(500, { error: `Valkey spool failed: ${(e as Error).message}` });
		}
	},
};
