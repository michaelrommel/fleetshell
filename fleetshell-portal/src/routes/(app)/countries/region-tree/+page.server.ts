import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';

// Countries is a primary section: any signed-in user may VIEW the region tree;
// writes are admin-gated (interim). This is where the "Country Manager" roles
// (CountryUserAdmin / CountryKeyUserAdmin / SRS Manager -- which already hold the
// region:create/edit/delete privileges) will maintain their country and add
// sub-regions (e.g. US states, Canada's Atlantic/Central/East/West/Pacific).
// Replace requireAdmin with authz_can('region', ...) scoped to the node once
// the authz fast-path is wired -- see docs/mdm_design.md.
async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

type TreeNode = { id: string; name: string; parent_id: string | null; kind: string; iso: string | null; child_count: number };
type Detail = { id: string; path: string; name: string; iso: string | null; level: number; kind: string; child_count: number; device_count: number };

// Geographic level -> badge label. World (level 1) is excluded from the tree, so
// countries (level 2) are the roots; everything below is a (sub-)region.
function kindOfLevel(level: number): string {
	if (level <= 2) return 'country';
	if (level === 3) return 'region';
	return 'subregion';
}

// Trim + upper-case a 2/3-letter ISO code; '' -> null.
function isoOrNull(raw: string): string | null {
	const s = raw.trim().toUpperCase();
	return s === '' ? null : s;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;
	const sel = url.searchParams.get('sel');
	const isNew = url.searchParams.get('new'); // 'country' to open the add-country form

	// The whole tree below World. parent_id is the id of the node one ltree level
	// up; countries (level 2) have their World parent filtered out (nlevel >= 2),
	// so they surface as roots -- mirroring how ProductTree drops its blank root.
	const rows = await globalDb<(Omit<TreeNode, 'kind'> & { level: number })[]>`
		SELECT r.id::text AS id, r.name, r.iso, nlevel(r.path)::int AS level,
		  (SELECT rp.id::text FROM region rp
		     WHERE rp.path = subpath(r.path, 0, nlevel(r.path) - 1) AND nlevel(rp.path) >= 2) AS parent_id,
		  (SELECT count(*) FROM region c
		     WHERE c.path <@ r.path AND c.path <> r.path AND nlevel(c.path) = nlevel(r.path) + 1)::int AS child_count
		FROM region r
		WHERE nlevel(r.path) >= 2
		ORDER BY r.name`;
	const nodes: TreeNode[] = rows.map((r) => ({
		id: r.id, name: r.name, iso: r.iso, parent_id: r.parent_id,
		child_count: r.child_count, kind: kindOfLevel(r.level),
	}));

	let detail: Detail | null = null;
	if (sel) {
		const [d] = await globalDb<Omit<Detail, 'kind'>[]>`
			SELECT r.id::text AS id, r.path::text AS path, r.name, r.iso, nlevel(r.path)::int AS level,
			  (SELECT count(*) FROM region c
			     WHERE c.path <@ r.path AND c.path <> r.path AND nlevel(c.path) = nlevel(r.path) + 1)::int AS child_count,
			  (SELECT count(*) FROM device dv WHERE dv.region_path <@ r.path)::int AS device_count
			FROM region r WHERE r.id = ${sel}`;
		if (d) detail = { ...d, kind: kindOfLevel(d.level) };
	}

	return { nodes, sel, isNew, detail, isAdmin };
};

export const actions: Actions = {
	// Create a country (parent_id '') under World, or a sub-region under a node.
	createNode: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const parentId = String(d.get('parent_id') ?? '').trim();
		const name = String(d.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Name required.' });

		let parentPath: string;
		let iso: string | null;
		if (!parentId) {
			// New country: parent is World (level 1); ISO comes from the form.
			const [world] = await globalDb<{ path: string }[]>`
				SELECT path::text AS path FROM region WHERE nlevel(path) = 1 ORDER BY id LIMIT 1`;
			if (!world) return fail(500, { error: 'World root not found.' });
			parentPath = world.path;
			iso = isoOrNull(String(d.get('iso') ?? ''));
		} else {
			// New sub-region: inherit the parent's ISO (country code).
			const [p] = await globalDb<{ path: string; iso: string | null }[]>`
				SELECT path::text AS path, iso FROM region WHERE id = ${parentId}`;
			if (!p) return fail(404, { error: 'Parent not found.' });
			parentPath = p.path;
			iso = p.iso;
		}

		const [{ id: newId }] = await globalDb<{ id: string }[]>`SELECT nextval('region_id_seq')::bigint AS id`;
		const path = `${parentPath}.${newId}`;
		const level = path.split('.').length;
		await globalDb`
			INSERT INTO region (id, path, name, iso, level, parent_id)
			VALUES (${newId}, ${path}::ltree, ${name}, ${iso},
			        ${level}, ${parentId ? Number(parentId) : Number(parentPath)})`;
		throw redirect(303, `${base}/countries/region-tree?sel=${encodeURIComponent(newId)}`);
	},

	// Edit a node's display attributes (name + ISO). Path / level / parent are
	// structural and never change here.
	saveNode: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		if (!id || !name) return fail(400, { error: 'Name required.' });
		const iso = isoOrNull(String(d.get('iso') ?? ''));
		await globalDb`UPDATE region SET name = ${name}, iso = ${iso} WHERE id = ${id}`;
		throw redirect(303, `${base}/countries/region-tree?sel=${encodeURIComponent(id)}`);
	},

	deleteNode: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Node required.' });
		const [node] = await globalDb<{ path: string }[]>`SELECT path::text AS path FROM region WHERE id = ${id}`;
		if (!node) throw redirect(303, `${base}/countries/region-tree`);
		const [{ n: children }] = await globalDb<{ n: number }[]>`
			SELECT count(*)::int AS n FROM region WHERE path <@ ${node.path}::ltree AND path <> ${node.path}::ltree`;
		if (children > 0) return fail(400, { error: `Has ${children} sub-region(s); delete them first.` });
		const [{ n: devices }] = await globalDb<{ n: number }[]>`
			SELECT count(*)::int AS n FROM device WHERE region_path <@ ${node.path}::ltree`;
		if (devices > 0) return fail(400, { error: `${devices} device(s) are located in this region.` });
		await globalDb`DELETE FROM region WHERE id = ${id}`;
		throw redirect(303, `${base}/countries/region-tree`);
	},
};
