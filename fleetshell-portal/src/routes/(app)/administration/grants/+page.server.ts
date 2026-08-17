import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb, localDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { bumpAuthzGen } from '$lib/server/cache';

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

type TreeNode = { group_id: string; label: string; parent_id: string | null; grant_count: number; member_count: number };
type GrantRow = {
	grant_id: string; role_name: string; resource_type: string; scope_kind: string;
	region: string; product: string; customer: string; site: string; group_scope: string; service_scope: string; single_label: string;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const sel = url.searchParams.get('sel');

	const raw = await globalDb<{ group_id: string; label: string; parent_id: string | null; grant_count: number }[]>`
		SELECT pg.group_id::text AS group_id, pg.label, pg.parent_id::text AS parent_id,
		       (SELECT count(*) FROM authz_grant g WHERE g.group_id = pg.group_id)::int AS grant_count
		FROM principal_group pg WHERE pg.label NOT LIKE 'user:%' ORDER BY pg.label`;
	const mcounts = await localDb<{ group_id: string; n: number }[]>`
		SELECT group_id::text AS group_id, count(*)::int AS n FROM group_membership GROUP BY group_id`;
	const mById = new Map(mcounts.map((c) => [c.group_id, c.n]));
	const nodes: TreeNode[] = raw.map((n) => ({ ...n, member_count: mById.get(n.group_id) ?? 0 }));

	const roles = await globalDb<{ id: string; name: string }[]>`
		SELECT id::text AS id, name FROM authz_role ORDER BY name`;

	let detail: { group_id: string; label: string } | null = null;
	let grants: GrantRow[] = [];
	if (sel) {
		[detail] = await globalDb<{ group_id: string; label: string }[]>`
			SELECT group_id::text AS group_id, label FROM principal_group WHERE group_id = ${sel}`;
		if (detail) {
			grants = await globalDb<GrantRow[]>`
				SELECT g.id::text AS grant_id, r.name AS role_name, s.resource_type, s.kind AS scope_kind,
				  COALESCE((SELECT string_agg(reg.name, ', ') FROM authz_scope_constraint c
				            JOIN region reg ON reg.path = ANY(c.values::ltree[])
				            WHERE c.scope_id = s.id AND c.dimension = 'region_path'), 'ANY') AS region,
				  COALESCE((SELECT string_agg(
				              COALESCE((SELECT tp.name FROM product tp WHERE tp.path = subltree(p.path, 0, LEAST(nlevel(p.path), 2))), p.name)
				                || ' / ' || CASE WHEN nlevel(p.path) <= 2 THEN 'ANY' ELSE p.name END, ', ')
				            FROM authz_scope_constraint c
				            JOIN product p ON p.path = ANY(c.values::ltree[])
				            WHERE c.scope_id = s.id AND c.dimension = 'product_path'), 'ANY') AS product,
				  COALESCE((SELECT string_agg(cu.name, ', ') FROM authz_scope_constraint c
				            JOIN customer cu ON cu.id = ANY(c.values::uuid[])
				            WHERE c.scope_id = s.id AND c.dimension = 'customer_id'), 'ANY') AS customer,
				  COALESCE((SELECT string_agg(si.name, ', ') FROM authz_scope_constraint c
				            JOIN customer_site si ON si.id = ANY(c.values::uuid[])
				            WHERE c.scope_id = s.id AND c.dimension = 'site_id'), 'ANY') AS site,
				  COALESCE((SELECT string_agg(gp.label, ', ') FROM authz_scope_constraint c
				            JOIN principal_group gp ON gp.path = ANY(c.values::ltree[])
				            WHERE c.scope_id = s.id AND c.dimension = 'group_path'), 'ANY') AS group_scope,
				  COALESCE((SELECT string_agg(sv.name, ', ') FROM authz_scope_constraint c
				            JOIN service sv ON sv.path = ANY(c.values::ltree[])
				            WHERE c.scope_id = s.id AND c.dimension = 'service_path'), 'ANY') AS service_scope,
				  COALESCE(s.label, '') AS single_label
				FROM authz_grant g
				JOIN authz_role r  ON r.id = g.role_id
				JOIN authz_scope s ON s.id = g.scope_id
				WHERE g.group_id = ${sel}
				ORDER BY r.name, s.resource_type, s.kind`;
		}
	}

	return { nodes, roles, sel, detail, grants };
};

export const actions: Actions = {
	createGrant: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		const role_id = String(d.get('role_id') ?? '');
		const resource_type = String(d.get('resource_type') ?? 'device');
		if (!group_id || !role_id) return fail(400, { error: 'Group and role required.' });
		if (!['device', 'group', 'service'].includes(resource_type)) return fail(400, { error: 'Unsupported resource type.' });

		const regions = d.getAll('region').map(String).filter(Boolean);
		const products = d.getAll('product').map(String).filter(Boolean);
		const customers = d.getAll('customer').map(String).filter(Boolean);
		const sites = d.getAll('site').map(String).filter(Boolean);
		const groupPaths = d.getAll('grouppath').map(String).filter(Boolean);
		const servicePaths = d.getAll('servicepath').map(String).filter(Boolean);

		// One grant per COMBINATION (cartesian product of the picked dimensions), so
		// multiple picks become multiple grant lines -- matches the legacy model and
		// lets each line be revoked individually. Empty dimension = ANY (one slot).
		type Combo = { region?: string; product?: string; customer?: string; site?: string; group?: string; service?: string };
		const orAny = (a: string[]): (string | undefined)[] => (a.length ? a : [undefined]);
		const combos: Combo[] = [];
		if (resource_type === 'device') {
			for (const region of orAny(regions))
				for (const product of orAny(products))
					for (const customer of orAny(customers))
						for (const site of orAny(sites))
							combos.push({ region, product, customer, site });
		} else if (resource_type === 'service') {
			for (const service of orAny(servicePaths)) combos.push({ service });
		} else {
			for (const group of orAny(groupPaths)) combos.push({ group });
		}
		if (combos.length > 500) {
			return fail(400, { error: `That would create ${combos.length} grants; pick fewer to stay under 500.` });
		}

		// The verbs the role confers for this resource type (for the future
		// grant-on-grant subset guard; harmless to store now).
		const [{ verbs }] = await globalDb<{ verbs: string[] }[]>`
			SELECT COALESCE(array_agg(pv.verb), '{}') AS verbs
			FROM authz_role_privilege rp JOIN authz_privilege pv ON pv.id = rp.privilege_id
			WHERE rp.role_id = ${role_id} AND pv.resource_type = ${resource_type}`;

		await globalDb.begin(async (sql) => {
			for (const combo of combos) {
				const [{ id: scopeId }] = await sql<{ id: string }[]>`
					INSERT INTO authz_scope (resource_type, kind, label) VALUES (${resource_type}, 'attribute', '')
					RETURNING id::text AS id`;
				const cons: { dim: string; op: string; vals: string[] }[] = [];
				if (combo.region) cons.push({ dim: 'region_path', op: 'subtree', vals: [combo.region] });
				if (combo.product) cons.push({ dim: 'product_path', op: 'subtree', vals: [combo.product] });
				if (combo.customer) cons.push({ dim: 'customer_id', op: 'in', vals: [combo.customer] });
				if (combo.site) cons.push({ dim: 'site_id', op: 'in', vals: [combo.site] });
				if (combo.group) cons.push({ dim: 'group_path', op: 'subtree', vals: [combo.group] });
				if (combo.service) cons.push({ dim: 'service_path', op: 'subtree', vals: [combo.service] });
				for (const c of cons) {
					await sql`INSERT INTO authz_scope_constraint (scope_id, dimension, op, values)
						VALUES (${scopeId}::uuid, ${c.dim}, ${c.op}, ${c.vals})`;
				}
				await sql`INSERT INTO authz_grant (group_id, role_id, scope_id, created_by, grant_resource_type, grant_verbs)
					VALUES (${group_id}::uuid, ${role_id}::uuid, ${scopeId}::uuid, ${locals.userId ?? null},
					        ${resource_type}, ${verbs})`;
			}
		});
		await bumpAuthzGen(); // new grant -> flush signature/page/count caches
		throw redirect(303, `${base}/administration/grants?sel=${encodeURIComponent(group_id)}`);
	},

	deleteGrant: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const grant_id = String(d.get('grant_id') ?? '');
		const group_id = String(d.get('group_id') ?? '');
		if (!grant_id) return fail(400, { error: 'Grant required.' });
		await globalDb.begin(async (sql) => {
			const [row] = await sql<{ scope_id: string }[]>`
				SELECT scope_id::text AS scope_id FROM authz_grant WHERE id = ${grant_id}`;
			await sql`DELETE FROM authz_grant WHERE id = ${grant_id}`;
			// Fresh scope per grant, so drop it too (constraints/devices cascade) if unused.
			if (row) {
				await sql`DELETE FROM authz_scope s WHERE s.id = ${row.scope_id}::uuid
					AND NOT EXISTS (SELECT 1 FROM authz_grant g WHERE g.scope_id = s.id)`;
			}
		});
		await bumpAuthzGen(); // grant removed -> flush signature/page/count caches
		throw redirect(303, group_id ? `${base}/administration/grants?sel=${encodeURIComponent(group_id)}` : `${base}/administration/grants`);
	},
};
