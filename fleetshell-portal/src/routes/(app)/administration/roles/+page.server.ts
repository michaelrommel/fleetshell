import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';

// Type rows (extensible) x fixed CRUD verbs (+ device:connect) = the matrix.
const TYPES = ['device','gateway','product','customer','site','region','group','service','role','grant','account','persona'];
const VERBS = ['create','view','edit','delete','connect'];

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'role';
}

type RoleRow = { id: string; key: string; name: string; priv_count: number; grant_count: number };

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const q = (url.searchParams.get('q') ?? '').trim();
	const sel = url.searchParams.get('sel');
	const isNew = url.searchParams.get('new') === '1';
	const like = '%' + q + '%';

	const search = q ? globalDb`AND (r.name ILIKE ${like} OR r.key ILIKE ${like})` : globalDb``;
	const [{ total }] = await globalDb<{ total: number }[]>`
		SELECT count(*)::int AS total FROM authz_role r WHERE true ${search}`;
	const roles = await globalDb<RoleRow[]>`
		SELECT r.id, r.key, r.name,
		       (SELECT count(*) FROM authz_role_privilege rp WHERE rp.role_id = r.id)::int AS priv_count,
		       (SELECT count(*) FROM authz_grant g WHERE g.role_id = r.id)::int AS grant_count
		FROM authz_role r
		WHERE true ${search}
		ORDER BY r.name LIMIT 500`;

	let detail: RoleRow | null = null;
	let matrix: { type: string; cells: { verb: string; id: string | null; checked: boolean }[] }[] = [];
	let usage = { grants: 0, groups: 0 };
	if (sel) {
		[detail] = await globalDb<RoleRow[]>`
			SELECT r.id, r.key, r.name, 0 AS priv_count, 0 AS grant_count FROM authz_role r WHERE r.id = ${sel}`;
		if (detail) {
			const catalog = await globalDb<{ id: string; resource_type: string; verb: string }[]>`
				SELECT id, resource_type, verb FROM authz_privilege`;
			const catMap = new Map(catalog.map((p) => [`${p.resource_type}:${p.verb}`, p.id]));
			const held = new Set((await globalDb<{ privilege_id: string }[]>`
				SELECT privilege_id FROM authz_role_privilege WHERE role_id = ${sel}`).map((r) => r.privilege_id));
			matrix = TYPES.map((type) => ({
				type,
				cells: VERBS.map((verb) => {
					const id = catMap.get(`${type}:${verb}`) ?? null;
					return { verb, id, checked: id ? held.has(id) : false };
				}),
			}));
			const [u] = await globalDb<{ grants: number; groups: number }[]>`
				SELECT count(*)::int AS grants, count(DISTINCT group_id)::int AS groups
				FROM authz_grant WHERE role_id = ${sel}`;
			usage = u ?? usage;
		}
	}

	return { q, total, roles, sel, isNew, detail, verbs: VERBS, matrix, usage };
};

export const actions: Actions = {
	createRole: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const name = String(d.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Role name required.' });
		const key = `${slug(name)}-${Math.random().toString(36).slice(2, 8)}`;
		const [row] = await globalDb<{ id: string }[]>`
			INSERT INTO authz_role (key, name) VALUES (${key}, ${name}) RETURNING id`;
		throw redirect(303, `${base}/administration/roles?sel=${encodeURIComponent(row.id)}`);
	},

	renameRole: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		if (!id || !name) return fail(400, { error: 'Name required.' });
		await globalDb`UPDATE authz_role SET name = ${name} WHERE id = ${id}`;
		throw redirect(303, `${base}/administration/roles?sel=${encodeURIComponent(id)}`);
	},

	setPrivileges: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Role required.' });
		const priv = d.getAll('priv').map(String).filter(Boolean);
		await globalDb.begin(async (sql) => {
			await sql`DELETE FROM authz_role_privilege WHERE role_id = ${id}`;
			if (priv.length) {
				await sql`INSERT INTO authz_role_privilege (role_id, privilege_id)
					SELECT ${id}, unnest(${priv}::uuid[])`;
			}
		});
		throw redirect(303, `${base}/administration/roles?sel=${encodeURIComponent(id)}`);
	},

	deleteRole: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Role required.' });
		const [{ n }] = await globalDb<{ n: number }[]>`
			SELECT count(*)::int AS n FROM authz_grant WHERE role_id = ${id}`;
		if (n > 0) {
			return fail(400, { error: `This role is used by ${n} grant(s). Remove those grants first.` });
		}
		await globalDb`DELETE FROM authz_role WHERE id = ${id}`;
		throw redirect(303, `${base}/administration/roles`);
	},
};
