import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { getPersona } from '$lib/server/identity';
import {
	listClasses, listVariants, listCountries, loadMatrix, saveMatrix, syncFromCountryToValkey,
} from '$lib/server/dtm';

// Editing a country's DTM is a Country-Manager concern (region:edit on the FROM
// country). Interim: admin-gated, matching the rest of the app. Replace with a
// scoped authz_can('region','edit') on the FROM country node later.
async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;

	const [classes, variants, countries] = await Promise.all([
		listClasses(), listVariants(), listCountries(),
	]);

	const from = url.searchParams.get('from');
	let variant = url.searchParams.get('variant') ?? variants[0]?.code ?? 'STD';
	if (!variants.some((v) => v.code === variant)) variant = variants[0]?.code ?? 'STD';

	let matrix: { defined: boolean; deny: Record<string, string[]> } | null = null;
	if (from) matrix = await loadMatrix(from, variant);

	return { classes, variants, countries, from, variant, matrix, isAdmin };
};

export const actions: Actions = {
	// Replace the whole FROM x variant matrix. Payload `deny` is a JSON object
	// { to_iso: [class_code, ...] } listing only denied cells.
	save: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const from = String(d.get('from') ?? '').trim();
		const variant = String(d.get('variant') ?? '').trim();
		if (!from || !variant) return fail(400, { error: 'Missing country or variant.' });

		let deny: Record<string, string[]>;
		try {
			const raw = JSON.parse(String(d.get('deny') ?? '{}'));
			if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('shape');
			deny = {};
			for (const [to, codes] of Object.entries(raw)) {
				if (!Array.isArray(codes)) return fail(400, { error: 'Bad matrix payload.' });
				const clean = codes.filter((c): c is string => typeof c === 'string');
				if (clean.length) deny[to] = clean;
			}
		} catch {
			return fail(400, { error: 'Bad matrix payload.' });
		}

		// Validate codes/variant against the catalog (FK would catch it too).
		const [classes, variants] = await Promise.all([listClasses(), listVariants()]);
		const valid = new Set(classes.map((c) => c.code));
		if (!variants.some((v) => v.code === variant)) return fail(400, { error: 'Unknown variant.' });
		for (const codes of Object.values(deny)) {
			for (const c of codes) if (!valid.has(c)) return fail(400, { error: `Unknown class: ${c}` });
		}

		const { cells } = await saveMatrix(from, variant, deny, locals.userId ?? null);
		return { saved: cells };
	},

	// Spool this FROM country (all its variants) into Valkey, atomically.
	export: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const from = String(d.get('from') ?? '').trim();
		if (!from) return fail(400, { error: 'Missing country.' });
		try {
			const res = await syncFromCountryToValkey(from);
			return { exported: `Exported ${from}: ${res.written} key(s) written, ${res.removed} replaced.` };
		} catch (e) {
			return fail(502, { error: `Valkey export failed: ${(e as Error).message}` });
		}
	},
};
