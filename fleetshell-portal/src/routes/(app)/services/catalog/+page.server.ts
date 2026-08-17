import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';

// The Services catalog: any signed-in user may VIEW the tree; writes are
// admin-gated (interim, matching Products/Administration).
async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

type TreeNode = { id: string; name: string; parent_id: string | null; kind: string; child_count: number };
type Detail = { id: string; path: string; kind: string; key: string | null; name: string; nlevel: number };
type GrantRow = { role_name: string; scope_label: string; group_label: string };

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;
	const sel = url.searchParams.get('sel');
	const isNew = url.searchParams.get('new'); // 'category' -> show the add-category form

	// The whole tree below the synthetic root (nlevel 1); categories become roots.
	const nodes = await globalDb<TreeNode[]>`
		SELECT s.id::text AS id, s.name, s.kind,
		  (SELECT sp.id::text FROM service sp
		     WHERE sp.path = subpath(s.path, 0, nlevel(s.path) - 1) AND nlevel(sp.path) >= 2) AS parent_id,
		  (SELECT count(*) FROM service c
		     WHERE c.path <@ s.path AND c.path <> s.path AND nlevel(c.path) = nlevel(s.path) + 1)::int AS child_count
		FROM service s
		WHERE nlevel(s.path) >= 2
		ORDER BY s.kind DESC, s.name`;

	let detail: Detail | null = null;
	let grants: GrantRow[] = [];
	if (sel) {
		[detail] = await globalDb<Detail[]>`
			SELECT id::text AS id, path::text AS path, kind, key, name, nlevel(path)::int AS nlevel
			FROM service WHERE id = ${sel}`;
		if (detail) {
			// Grants whose service scope covers this node (subtree ancestor-or-self).
			grants = await globalDb<GrantRow[]>`
				SELECT r.name AS role_name, s.label AS scope_label, pg.label AS group_label
				FROM authz_scope s
				JOIN authz_scope_constraint c ON c.scope_id = s.id AND c.dimension = 'service_path'
				JOIN authz_grant g ON g.scope_id = s.id
				JOIN authz_role r ON r.id = g.role_id
				JOIN principal_group pg ON pg.group_id = g.group_id
				WHERE s.resource_type = 'service'
				  AND ${detail.path}::ltree <@ (c.values[1])::ltree
				ORDER BY pg.label, r.name`;
		}
	}

	return { nodes, sel, isNew, detail, grants, isAdmin };
};

export const actions: Actions = {
	createNode: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const parentId = String(d.get('parent_id') ?? '').trim(); // '' = add a category under root
		const name = String(d.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Name required.' });

		let parentPath: string;
		let kind: 'category' | 'service';
		if (!parentId) {
			const [root] = await globalDb<{ path: string }[]>`
				SELECT path::text AS path FROM service WHERE nlevel(path) = 1 LIMIT 1`;
			if (!root) return fail(500, { error: 'Catalog root missing; apply migrate_services_authz.sql.' });
			parentPath = root.path;
			kind = 'category';
		} else {
			const [p] = await globalDb<{ path: string; kind: string }[]>`
				SELECT path::text AS path, kind FROM service WHERE id = ${parentId}`;
			if (!p) return fail(404, { error: 'Parent not found.' });
			if (p.kind === 'root') kind = 'category';
			else if (p.kind === 'category') kind = 'service';
			else return fail(400, { error: 'Services have no child level.' });
			parentPath = p.path;
		}

		// User-added node: uuid-derived ltree label (labels are [A-Za-z0-9_]); no key.
		const [row] = await globalDb<{ id: string }[]>`
			INSERT INTO service (path, kind, name)
			VALUES (
				(${parentPath + '.'} || 'n' || replace(gen_random_uuid()::text, '-', ''))::ltree,
				${kind}, ${name})
			RETURNING id::text AS id`;
		throw redirect(303, `${base}/services/catalog?sel=${encodeURIComponent(row.id)}`);
	},

	rename: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		if (!id || !name) return fail(400, { error: 'Name required.' });
		await globalDb`UPDATE service SET name = ${name} WHERE id = ${id}`;
		throw redirect(303, `${base}/services/catalog?sel=${encodeURIComponent(id)}`);
	},

	deleteNode: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Node required.' });
		const [node] = await globalDb<{ path: string; kind: string; key: string | null }[]>`
			SELECT path::text AS path, kind, key FROM service WHERE id = ${id}`;
		if (!node) throw redirect(303, `${base}/services/catalog`);
		if (node.kind === 'root') return fail(400, { error: 'The catalog root cannot be deleted.' });
		const [{ n: children }] = await globalDb<{ n: number }[]>`
			SELECT count(*)::int AS n FROM service WHERE path <@ ${node.path}::ltree AND path <> ${node.path}::ltree`;
		if (children > 0) return fail(400, { error: `Has ${children} descendant node(s); delete them first.` });
		// Block deletion if a service scope references this subtree (grants exist).
		const [{ n: refs }] = await globalDb<{ n: number }[]>`
			SELECT count(*)::int AS n
			FROM authz_scope_constraint c
			WHERE c.dimension = 'service_path' AND ${node.path}::ltree <@ (c.values[1])::ltree`;
		if (refs > 0) return fail(400, { error: `${refs} grant scope(s) reference this function; revoke them first.` });
		await globalDb`DELETE FROM service WHERE id = ${id}`;
		throw redirect(303, `${base}/services/catalog`);
	},
};
