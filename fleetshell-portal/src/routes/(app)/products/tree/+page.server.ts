import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';

// Products is a primary section: any signed-in user may VIEW the tree; writes
// are admin-gated (interim, matching the Administration section -- see
// docs/product_admin.md section 6).
async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

const APPLICATIONS = ['http', 'https', 'expert-i', 'rdp', 'vnc', 'ssh'];

type TreeNode = { id: string; name: string; parent_id: string | null; kind: string; child_count: number };
type Detail = { id: string; path: string; kind: string; name: string; family: string | null; nlevel: number };
type Model = { partno: string | null; serial_from: string | null; serial_to: string | null; is_host_computer: boolean };
type AppRow = {
	id: string; name: string; application: string; ports: string; guac: boolean; e2ecrypt: boolean;
	sni: string; path: string; width: number; height: number; dpi: number; drive: boolean; record: boolean; ssh_compat: boolean; sort_order: number;
};

/** Parse an optional integer field; '' -> null, non-integer -> throws marker. */
function intOrNull(raw: string): number | null | 'bad' {
	const s = raw.trim();
	if (s === '') return null;
	if (!/^\d+$/.test(s)) return 'bad';
	return Number(s);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;
	const sel = url.searchParams.get('sel');
	const isNew = url.searchParams.get('new'); // 'modality' to open the add-modality form

	// The whole tree. parent_id is the id of the node one ltree level up; the
	// synthetic blank root (nlevel 1) is excluded and its children become roots.
	const nodes = await globalDb<TreeNode[]>`
		SELECT p.id::text AS id, p.name, p.kind,
		  (SELECT pp.id::text FROM product pp
		     WHERE pp.path = subpath(p.path, 0, nlevel(p.path) - 1) AND nlevel(pp.path) >= 2) AS parent_id,
		  (SELECT count(*) FROM product c
		     WHERE c.path <@ p.path AND c.path <> p.path AND nlevel(c.path) = nlevel(p.path) + 1)::int AS child_count
		FROM product p
		WHERE nlevel(p.path) >= 2
		ORDER BY p.kind DESC, p.name`;

	let detail: Detail | null = null;
	let model: Model | null = null;
	let apps: AppRow[] = [];
	if (sel) {
		[detail] = await globalDb<Detail[]>`
			SELECT id::text AS id, path::text AS path, kind, name, family, nlevel(path)::int AS nlevel
			FROM product WHERE id = ${sel}`;
		if (detail?.kind === 'model') {
			[model] = await globalDb<Model[]>`
				SELECT partno::text AS partno, serial_from::text AS serial_from,
				       serial_to::text AS serial_to, is_host_computer
				FROM product_model WHERE product_id = ${sel}`;
			model ??= { partno: null, serial_from: null, serial_to: null, is_host_computer: false };
			apps = await globalDb<AppRow[]>`
				SELECT id::text AS id, name, application, ports, guac, e2ecrypt, sni, path,
				       width, height, dpi, drive, record, ssh_compat, sort_order
				FROM product_model_app WHERE product_id = ${sel}
				ORDER BY sort_order, name`;
		}
	}

	return { nodes, sel, isNew, detail, model, apps, isAdmin };
};

export const actions: Actions = {
	// --- tree structure ------------------------------------------------------
	createNode: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const parentId = String(d.get('parent_id') ?? '').trim(); // '' = add a modality under root
		const name = String(d.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Name required.' });

		let parentPath: string;
		let kind: 'modality' | 'product' | 'model';
		if (!parentId) {
			const [root] = await globalDb<{ path: string }[]>`
				SELECT path::text AS path FROM product WHERE nlevel(path) = 1 LIMIT 1`;
			parentPath = root?.path ?? '';
			kind = 'modality';
		} else {
			const [p] = await globalDb<{ path: string; kind: string }[]>`
				SELECT path::text AS path, kind FROM product WHERE id = ${parentId}`;
			if (!p) return fail(404, { error: 'Parent not found.' });
			if (p.kind === 'modality') kind = 'product';
			else if (p.kind === 'product') kind = 'model';
			else return fail(400, { error: 'Models have no child level.' });
			parentPath = p.path;
		}

		// New leaf label: a fresh uuid-derived token (ltree labels are [A-Za-z0-9_]).
		const [row] = await globalDb<{ id: string }[]>`
			INSERT INTO product (path, kind, name)
			VALUES (
				(${parentPath ? parentPath + '.' : ''} || 'n' || replace(gen_random_uuid()::text, '-', ''))::ltree,
				${kind}, ${name})
			RETURNING id::text AS id`;
		if (kind === 'model') {
			await globalDb`INSERT INTO product_model (product_id) VALUES (${row.id})`;
		}
		throw redirect(303, `${base}/products/tree?sel=${encodeURIComponent(row.id)}`);
	},

	rename: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		if (!id || !name) return fail(400, { error: 'Name required.' });
		await globalDb`UPDATE product SET name = ${name} WHERE id = ${id}`;
		throw redirect(303, `${base}/products/tree?sel=${encodeURIComponent(id)}`);
	},

	setFamily: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const family = String(d.get('family') ?? '').trim();
		if (!id) return fail(400, { error: 'Product required.' });
		await globalDb`UPDATE product SET family = ${family || null} WHERE id = ${id} AND kind = 'product'`;
		throw redirect(303, `${base}/products/tree?sel=${encodeURIComponent(id)}`);
	},

	saveModel: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		if (!id || !name) return fail(400, { error: 'Name required.' });
		const partno = intOrNull(String(d.get('partno') ?? ''));
		const from = intOrNull(String(d.get('serial_from') ?? ''));
		const to = intOrNull(String(d.get('serial_to') ?? ''));
		if (partno === 'bad' || from === 'bad' || to === 'bad')
			return fail(400, { error: 'Part number and serials must be whole numbers.' });
		if (from !== null && to !== null && (from as number) > (to as number))
			return fail(400, { error: 'Serial-from must not exceed serial-to.' });
		const isHost = d.get('is_host_computer') === 'on';

		await globalDb`UPDATE product SET name = ${name} WHERE id = ${id} AND kind = 'model'`;
		await globalDb`
			INSERT INTO product_model (product_id, partno, serial_from, serial_to, is_host_computer)
			VALUES (${id}, ${partno as number | null}, ${from as number | null}, ${to as number | null}, ${isHost})
			ON CONFLICT (product_id) DO UPDATE
			SET partno = EXCLUDED.partno, serial_from = EXCLUDED.serial_from,
			    serial_to = EXCLUDED.serial_to, is_host_computer = EXCLUDED.is_host_computer`;
		throw redirect(303, `${base}/products/tree?sel=${encodeURIComponent(id)}`);
	},

	deleteNode: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Node required.' });
		const [node] = await globalDb<{ path: string }[]>`SELECT path::text AS path FROM product WHERE id = ${id}`;
		if (!node) throw redirect(303, `${base}/products/tree`);
		const [{ n: children }] = await globalDb<{ n: number }[]>`
			SELECT count(*)::int AS n FROM product WHERE path <@ ${node.path}::ltree AND path <> ${node.path}::ltree`;
		if (children > 0) return fail(400, { error: `Has ${children} descendant node(s); delete or move them first.` });
		const [{ n: devices }] = await globalDb<{ n: number }[]>`
			SELECT count(*)::int AS n FROM device WHERE product_path <@ ${node.path}::ltree`;
		if (devices > 0) return fail(400, { error: `${devices} device(s) reference this node.` });
		// product_model + product_model_app cascade on the product FK.
		await globalDb`DELETE FROM product WHERE id = ${id}`;
		throw redirect(303, `${base}/products/tree`);
	},

	// --- application list (model level): replace-all save ---------------------
	saveApps: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const productId = String(d.get('product_id') ?? '');
		if (!productId) return fail(400, { error: 'Model required.' });
		let raw: unknown;
		try { raw = JSON.parse(String(d.get('apps') ?? '[]')); } catch { return fail(400, { error: 'Bad application data.' }); }
		if (!Array.isArray(raw)) return fail(400, { error: 'Bad application data.' });

		const rows: {
			name: string; application: string; ports: string; guac: boolean; e2ecrypt: boolean;
			sni: string; path: string; width: number; height: number; dpi: number; drive: boolean; record: boolean; ssh_compat: boolean; sort_order: number;
		}[] = [];
		for (const r of raw as Record<string, unknown>[]) {
			const application = String(r.application ?? '');
			if (!APPLICATIONS.includes(application)) return fail(400, { error: `Unknown application type: ${application}` });
			const name = String(r.name ?? '').trim();
			const ports = String(r.ports ?? '').trim();
			if (!name && !ports) continue;                 // drop blank rows
			const guacApplicable = application === 'rdp' || application === 'vnc' || application === 'ssh';
			const httpApplicable = application === 'http' || application === 'https' || application === 'expert-i';
			const guac = guacApplicable && !!r.guac;
			const e2ecrypt = !guac && !!r.e2ecrypt;
			rows.push({
				name, application, ports, guac, e2ecrypt,
				sni: httpApplicable && !guac && !e2ecrypt ? String(r.sni ?? '').trim() : '',
				path: httpApplicable ? (String(r.path ?? '').trim() || '/') : '/',
				width: Number(r.width) || 1920,
				height: Number(r.height) || 1080,
				dpi: Number(r.dpi) || 96,
				drive: guac && application === 'rdp' && !!r.drive,
				record: guac && !!r.record,
				// ssh_compat only applies to SSH direct (russh) mode: not guac, not e2e.
				ssh_compat: application === 'ssh' && !guac && !e2ecrypt && !!r.ssh_compat,
				sort_order: rows.length,
			});
		}

		await globalDb.begin(async (sql) => {
			await sql`DELETE FROM product_model_app WHERE product_id = ${productId}`;
			for (const a of rows) {
				await sql`
					INSERT INTO product_model_app
						(product_id, name, application, ports, guac, e2ecrypt, sni, path, width, height, dpi, drive, record, ssh_compat, sort_order)
					VALUES (${productId}, ${a.name}, ${a.application}, ${a.ports}, ${a.guac}, ${a.e2ecrypt}, ${a.sni}, ${a.path},
						${a.width}, ${a.height}, ${a.dpi}, ${a.drive}, ${a.record}, ${a.ssh_compat}, ${a.sort_order})`;
			}
		});
		throw redirect(303, `${base}/products/tree?sel=${encodeURIComponent(productId)}`);
	},
};
