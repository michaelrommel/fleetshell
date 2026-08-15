import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { resolveModality, syncModalityToValkey, CLASS_ORDER } from '$lib/server/classification';

// Data classification is part of editing the product tree -> gated by
// product:edit, which is anchored to the modality (a BU Representative owns their
// modality). Phase 1 uses the interim is_admin gate, like the rest of /products.
async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

type Modality = { id: string; name: string };
type SetRow = { id: string; name: string; description: string | null; rule_count: number; assign_count: number };
type RuleRow = { id: string; regex: string; codes: string[]; sort_order: number };
type ProductRow = { id: string; name: string; family: string | null };
type AssignRow = { set_id: string; product_id: string | null; family: string | null };

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;

	const modalities = await globalDb<Modality[]>`
		SELECT id::text AS id, name FROM product
		WHERE kind = 'modality' AND name <> '' ORDER BY name`;

	const modId = url.searchParams.get('mod') || modalities[0]?.id || null;
	const view = (url.searchParams.get('view') || 'sets') as 'sets' | 'assign' | 'preview';
	const selSet = url.searchParams.get('set');

	const dataClasses = await globalDb<{ code: string; label: string }[]>`
		SELECT code, label FROM data_class ORDER BY sort_order`;

	if (!modId) {
		return { modalities, modId, view, selSet, isAdmin, dataClasses,
			sets: [], rules: [], products: [], assignments: [], preview: [] };
	}

	const sets = await globalDb<SetRow[]>`
		SELECT s.id::text AS id, s.name, s.description,
		       (SELECT count(*) FROM classification_rule r WHERE r.set_id = s.id)::int AS rule_count,
		       (SELECT count(*) FROM classification_assignment a WHERE a.set_id = s.id)::int AS assign_count
		FROM classification_set s
		WHERE s.modality_id = ${modId}
		ORDER BY s.name`;

	let rules: RuleRow[] = [];
	if (selSet && sets.some((s) => s.id === selSet)) {
		rules = await globalDb<RuleRow[]>`
			SELECT r.id::text AS id, r.regex, r.sort_order,
			       COALESCE(array_agg(rc.code) FILTER (WHERE rc.code IS NOT NULL), '{}') AS codes
			FROM classification_rule r
			LEFT JOIN classification_rule_class rc ON rc.rule_id = r.id
			WHERE r.set_id = ${selSet}
			GROUP BY r.id, r.regex, r.sort_order
			ORDER BY r.sort_order`;
	}

	const [mod] = await globalDb<{ path: string }[]>`
		SELECT path::text AS path FROM product WHERE id = ${modId}`;
	const products = mod
		? await globalDb<ProductRow[]>`
			SELECT id::text AS id, name, family FROM product
			WHERE kind = 'product' AND path <@ ${mod.path}::ltree ORDER BY family NULLS FIRST, name`
		: [];

	const assignments = await globalDb<AssignRow[]>`
		SELECT a.set_id::text AS set_id, a.product_id::text AS product_id, a.family
		FROM classification_assignment a
		JOIN classification_set s ON s.id = a.set_id
		WHERE s.modality_id = ${modId}`;

	const preview = view === 'preview' ? (await resolveModality(modId)).products : [];

	return { modalities, modId, view, selSet, isAdmin, dataClasses,
		sets, rules, products, assignments, preview };
};

/** Validate that a product node belongs to the modality. */
async function productInModality(productId: string, modId: string): Promise<boolean> {
	const [row] = await globalDb<{ ok: boolean }[]>`
		SELECT EXISTS (
			SELECT 1 FROM product p
			JOIN product m ON m.id = ${modId} AND m.kind = 'modality'
			WHERE p.id = ${productId} AND p.kind = 'product' AND p.path <@ m.path
		) AS ok`;
	return row?.ok ?? false;
}

function backTo(modId: string, view: string, set?: string | null): string {
	const u = new URLSearchParams({ mod: modId, view });
	if (set) u.set('set', set);
	return `${base}/products/classification?${u}`;
}

export const actions: Actions = {
	createSet: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const modId = String(d.get('mod') ?? '');
		const name = String(d.get('name') ?? '').trim();
		if (!modId || !name) return fail(400, { error: 'Set name required.' });
		let id: string;
		try {
			[{ id }] = await globalDb<{ id: string }[]>`
				INSERT INTO classification_set (modality_id, name) VALUES (${modId}, ${name})
				RETURNING id::text AS id`;
		} catch {
			return fail(400, { error: 'A set with that name already exists in this modality.' });
		}
		throw redirect(303, backTo(modId, 'sets', id));
	},

	updateSet: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const modId = String(d.get('mod') ?? '');
		const id = String(d.get('id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		const description = String(d.get('description') ?? '').trim();
		if (!id || !name) return fail(400, { error: 'Set name required.' });
		await globalDb`UPDATE classification_set SET name = ${name}, description = ${description || null} WHERE id = ${id}`;
		throw redirect(303, backTo(modId, 'sets', id));
	},

	deleteSet: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const modId = String(d.get('mod') ?? '');
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Set required.' });
		await globalDb`DELETE FROM classification_set WHERE id = ${id}`;
		throw redirect(303, backTo(modId, 'sets'));
	},

	// Replace-all save of a set's rules (regex + class codes).
	saveRules: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const modId = String(d.get('mod') ?? '');
		const setId = String(d.get('set_id') ?? '');
		if (!setId) return fail(400, { error: 'Set required.' });
		let raw: unknown;
		try { raw = JSON.parse(String(d.get('rules') ?? '[]')); } catch { return fail(400, { error: 'Bad rule data.' }); }
		if (!Array.isArray(raw)) return fail(400, { error: 'Bad rule data.' });

		const valid = new Set(CLASS_ORDER);
		const rows: { regex: string; codes: string[] }[] = [];
		for (const r of raw as Record<string, unknown>[]) {
			const regex = String(r.regex ?? '').trim();
			if (!regex) continue;                 // drop blank rows
			const codes = Array.isArray(r.codes)
				? [...new Set((r.codes as unknown[]).map(String).filter((c) => valid.has(c)))]
				: [];
			rows.push({ regex, codes });
		}

		await globalDb.begin(async (sql) => {
			await sql`DELETE FROM classification_rule WHERE set_id = ${setId}`;
			for (let i = 0; i < rows.length; i++) {
				const [{ id }] = await sql<{ id: string }[]>`
					INSERT INTO classification_rule (set_id, regex, sort_order)
					VALUES (${setId}, ${rows[i].regex}, ${i}) RETURNING id::text AS id`;
				for (const code of rows[i].codes) {
					await sql`INSERT INTO classification_rule_class (rule_id, code) VALUES (${id}, ${code})`;
				}
			}
		});
		throw redirect(303, backTo(modId, 'sets', setId));
	},

	// Toggle a single (set, target) assignment. target = product:<id> | family:<value> | modality.
	toggleAssign: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const modId = String(d.get('mod') ?? '');
		const setId = String(d.get('set_id') ?? '');
		const target = String(d.get('target') ?? '');
		if (!setId || !target) return fail(400, { error: 'Set and target required.' });

		let productId: string | null = null;
		let family: string | null = null;
		if (target.startsWith('product:')) {
			productId = target.slice('product:'.length);
			if (!(await productInModality(productId, modId)))
				return fail(400, { error: 'Product not in this modality.' });
		} else if (target.startsWith('family:')) {
			family = target.slice('family:'.length);
		} // else modality-wide (both null)

		const existing = productId
			? await globalDb`SELECT id FROM classification_assignment WHERE set_id = ${setId} AND product_id = ${productId}`
			: family
				? await globalDb`SELECT id FROM classification_assignment WHERE set_id = ${setId} AND family = ${family}`
				: await globalDb`SELECT id FROM classification_assignment WHERE set_id = ${setId} AND product_id IS NULL AND family IS NULL`;

		if (existing.length > 0) {
			if (productId) await globalDb`DELETE FROM classification_assignment WHERE set_id = ${setId} AND product_id = ${productId}`;
			else if (family) await globalDb`DELETE FROM classification_assignment WHERE set_id = ${setId} AND family = ${family}`;
			else await globalDb`DELETE FROM classification_assignment WHERE set_id = ${setId} AND product_id IS NULL AND family IS NULL`;
		} else {
			await globalDb`INSERT INTO classification_assignment (set_id, product_id, family) VALUES (${setId}, ${productId}, ${family})`;
		}
		throw redirect(303, backTo(modId, 'assign'));
	},

	syncValkey: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const modId = String(d.get('mod') ?? '');
		if (!modId) return fail(400, { error: 'Modality required.' });
		try {
			const res = await syncModalityToValkey(modId);
			return { synced: `Synced ${res.modalityName}: ${res.written} key(s) written, ${res.deleted} removed.` };
		} catch (e) {
			return fail(500, { error: `Valkey sync failed: ${(e as Error).message}` });
		}
	},
};
