import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb, localDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { invalidateUserGroups, resolveGroupIds, canGroup, visibleGroupIds } from '$lib/server/authz';
import { bumpAuthzGen } from '$lib/server/cache';
import { grantScopeColumns, type GrantScope } from '$lib/grantScope';

const MEMBER_LIMIT = 50;

// Access model for the (relocated) top-level Groups page. Unlike the
// Administration section (is_admin-gated), this page is reachable by an
// appointed "group admin" -- a persona whose groups hold a group-scoped grant
// (GroupAdmin role) over a subtree. Such a persona may FULLY manage that
// subtree: add/remove members, rename, and create sub-groups. Deleting a group
// stays is_admin-only (destructive, can orphan history). is_admin personas keep
// unrestricted control over every group.
type Access = { isAdmin: boolean; groupIds: string[] };

async function getAccess(locals: App.Locals): Promise<Access> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = !!persona?.is_admin;
	const groupIds = isAdmin ? [] : await resolveGroupIds(locals.userId);
	return { isAdmin, groupIds };
}

/** Guard a manage action (add/remove member, rename, create sub-group) on one
 *  target group: admin always passes; otherwise the persona needs group:edit on
 *  that group's subtree. Throws 403 on denial. */
async function requireGroupEdit(locals: App.Locals, targetGroupId: string): Promise<void> {
	const { isAdmin, groupIds } = await getAccess(locals);
	if (isAdmin) return;
	if (!targetGroupId || !(await canGroup(groupIds, 'edit', targetGroupId))) {
		throw error(403, 'You do not manage this group.');
	}
}

type TreeNode = { group_id: string; label: string; parent_id: string | null; grant_count: number; member_count: number };
type GroupRow = { group_id: string; label: string; home_region: string };
type GrantRow = { grant_id: string; role_name: string } & GrantScope;

export const load: PageServerLoad = async ({ locals, url }) => {
	const { isAdmin, groupIds } = await getAccess(locals);
	const sel = url.searchParams.get('sel');
	const isNew = url.searchParams.get('new') === '1';
	const mq = (url.searchParams.get('mq') ?? '').trim(); // member filter within a group

	// Non-admins only see the group ids they may VIEW (their granted subtrees).
	// An empty set means they hold no group grant at all -> no access.
	let visibleIds: string[] | null = null;
	if (!isAdmin) {
		visibleIds = await visibleGroupIds(groupIds, 'view');
		if (visibleIds.length === 0) throw error(403, 'You do not manage any groups.');
	}

	// The org-group tree (excludes legacy per-person 'user:' groups). Admins get
	// the whole tree; group admins get only their visible ids, re-rooted so a
	// granted subtree's top node renders as a root (its real parent is hidden).
	const scope = visibleIds ? globalDb`AND pg.group_id = ANY(${visibleIds}::uuid[])` : globalDb``;
	const raw = await globalDb<{ group_id: string; label: string; parent_id: string | null; grant_count: number }[]>`
		SELECT pg.group_id::text AS group_id, pg.label, pg.parent_id::text AS parent_id,
		       (SELECT count(*) FROM authz_grant g WHERE g.group_id = pg.group_id)::int AS grant_count
		FROM principal_group pg
		WHERE pg.label NOT LIKE 'user:%' ${scope}
		ORDER BY pg.label`;
	const idSet = new Set(raw.map((n) => n.group_id));
	const mcounts = await localDb<{ group_id: string; n: number }[]>`
		SELECT group_id::text AS group_id, count(*)::int AS n FROM group_membership GROUP BY group_id`;
	const mById = new Map(mcounts.map((c) => [c.group_id, c.n]));
	const nodes: TreeNode[] = raw.map((n) => ({
		...n,
		// Re-root: if a node's parent is not in the visible set, treat it as a root.
		parent_id: n.parent_id && idSet.has(n.parent_id) ? n.parent_id : null,
		member_count: mById.get(n.group_id) ?? 0,
	}));

	let detail: GroupRow | null = null;
	let grants: GrantRow[] = [];
	let members: { user_id: string; firstname: string; lastname: string; role_label: string | null }[] = [];
	let memberTotal = 0;
	// Capabilities for the selected group, resolved server-side (the UI mirrors
	// these; every action re-checks authoritatively).
	let caps = { canEdit: false, canCreateChild: false, canDelete: false };
	if (sel) {
		// A group admin may only open a group inside their visible set.
		if (visibleIds && !idSet.has(sel)) throw error(403, 'You do not manage this group.');
		[detail] = await globalDb<GroupRow[]>`
			SELECT pg.group_id::text AS group_id, pg.label, pg.home_region
			FROM principal_group pg WHERE pg.group_id = ${sel}`;
		if (detail) {
			const canEdit = isAdmin || (await canGroup(groupIds, 'edit', sel));
			caps = { canEdit, canCreateChild: canEdit, canDelete: isAdmin };
			grants = await globalDb<GrantRow[]>`
				SELECT g.id::text AS grant_id, r.name AS role_name, ${grantScopeColumns(globalDb)}
				FROM authz_grant g
				JOIN authz_role r  ON r.id = g.role_id
				JOIN authz_scope s ON s.id = g.scope_id
				WHERE g.group_id = ${sel}
				ORDER BY r.name, s.resource_type, s.kind, region, product`;
			[{ n: memberTotal }] = await localDb<{ n: number }[]>`
				SELECT count(*)::int AS n FROM group_membership WHERE group_id = ${sel}::uuid`;
			const mfilter = mq ? localDb`AND (u.firstname ILIKE ${'%' + mq + '%'} OR u.lastname ILIKE ${'%' + mq + '%'})` : localDb``;
			members = await localDb<{ user_id: string; firstname: string; lastname: string; role_label: string | null }[]>`
				SELECT u.user_id, u.firstname, u.lastname, u.role_label
				FROM group_membership m JOIN app_user u ON u.user_id = m.user_id
				WHERE m.group_id = ${sel}::uuid ${mfilter}
				ORDER BY u.lastname, u.firstname LIMIT ${MEMBER_LIMIT}`;
		}
	}

	return { nodes, sel, isNew, detail, grants, members, memberTotal, mq, isAdmin, caps };
};

export const actions: Actions = {
	createGroup: async ({ request, locals }) => {
		const d = await request.formData();
		const label = String(d.get('label') ?? '').trim();
		const parentId = String(d.get('parent_id') ?? '').trim();
		if (!label) return fail(400, { error: 'Group label required.' });

		// Sub-group: path = parent.path + a fresh opaque segment, parent_id set. The
		// ltree path is what grant inheritance keys off (ancestor @> descendant), so
		// appending under the parent makes the child inherit the parent's grants.
		if (parentId) {
			// Creating a child = editing the parent subtree (group admins allowed).
			await requireGroupEdit(locals, parentId);
			const [parent] = await globalDb<{ path: string; home_region: string }[]>`
				SELECT path::text AS path, home_region FROM principal_group WHERE group_id = ${parentId}`;
			if (!parent) return fail(404, { error: 'Parent group not found.' });
			const [row] = await globalDb<{ group_id: string }[]>`
				INSERT INTO principal_group (home_region, label, path, parent_id)
				VALUES (${parent.home_region}, ${label},
					(${parent.path + '.'} || 'g' || replace(gen_random_uuid()::text, '-', ''))::ltree,
					${parentId}::uuid)
				RETURNING group_id::text AS group_id`;
			throw redirect(303, `${base}/groups?sel=${encodeURIComponent(row.group_id)}`);
		}

		// Flat (root) group: is_admin only (a new root is outside any granted subtree).
		await requireAdmin(locals);
		const home_region = String(d.get('home_region') ?? 'eu-west-2').trim() || 'eu-west-2';
		const [row] = await globalDb<{ group_id: string }[]>`
			INSERT INTO principal_group (home_region, label, path)
			VALUES (${home_region}, ${label}, ('g' || replace(gen_random_uuid()::text, '-', ''))::ltree)
			RETURNING group_id::text AS group_id`;
		throw redirect(303, `${base}/groups?sel=${encodeURIComponent(row.group_id)}`);
	},

	renameGroup: async ({ request, locals }) => {
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		const label = String(d.get('label') ?? '').trim();
		if (!group_id || !label) return fail(400, { error: 'Label required.' });
		await requireGroupEdit(locals, group_id);
		await globalDb`UPDATE principal_group SET label = ${label} WHERE group_id = ${group_id}`;
		throw redirect(303, `${base}/groups?sel=${encodeURIComponent(group_id)}`);
	},

	addMember: async ({ request, locals }) => {
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		const user_id = String(d.get('user_id') ?? '').trim();
		if (!group_id || !user_id) return fail(400, { error: 'Group and persona required.' });
		await requireGroupEdit(locals, group_id);
		const [ok] = await localDb<{ ok: boolean }[]>`SELECT true AS ok FROM app_user WHERE user_id = ${user_id}`;
		if (!ok) return fail(404, { error: 'No such persona user_id.' });
		await localDb`
			INSERT INTO group_membership (group_id, user_id, added_by)
			VALUES (${group_id}::uuid, ${user_id}, ${locals.userId ?? null})
			ON CONFLICT (group_id, user_id) DO NOTHING`;
		await invalidateUserGroups(user_id);
		throw redirect(303, `${base}/groups?sel=${encodeURIComponent(group_id)}`);
	},

	removeMember: async ({ request, locals }) => {
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		const user_id = String(d.get('user_id') ?? '');
		await requireGroupEdit(locals, group_id);
		await localDb`DELETE FROM group_membership WHERE group_id = ${group_id}::uuid AND user_id = ${user_id}`;
		await invalidateUserGroups(user_id);
		throw redirect(303, `${base}/groups?sel=${encodeURIComponent(group_id)}`);
	},

	deleteGroup: async ({ request, locals }) => {
		// Destructive: is_admin only.
		await requireAdmin(locals);
		const d = await request.formData();
		const group_id = String(d.get('group_id') ?? '');
		if (!group_id) return fail(400, { error: 'Group required.' });
		// Block deletion if it has sub-groups (would orphan them in the ltree).
		const [node] = await globalDb<{ path: string }[]>`
			SELECT path::text AS path FROM principal_group WHERE group_id = ${group_id}`;
		if (node) {
			const [{ n: children }] = await globalDb<{ n: number }[]>`
				SELECT count(*)::int AS n FROM principal_group
				WHERE path <@ ${node.path}::ltree AND path <> ${node.path}::ltree`;
			if (children > 0) return fail(400, { error: `Has ${children} sub-group(s); delete or move them first.` });
		}
		// Grants on the group cascade (global). Membership is cross-DB (no FK), so
		// clean the local rows explicitly.
		const members = await localDb<{ user_id: string }[]>`
			SELECT user_id FROM group_membership WHERE group_id = ${group_id}::uuid`;
		await globalDb`DELETE FROM principal_group WHERE group_id = ${group_id}`;
		await localDb`DELETE FROM group_membership WHERE group_id = ${group_id}::uuid`;
		for (const m of members) await invalidateUserGroups(m.user_id);
		await bumpAuthzGen(); // grants on the group were deleted -> flush sig/page caches
		throw redirect(303, `${base}/groups`);
	},
};

// is_admin gate for the root-create + delete actions (kept local to avoid
// leaking the getAccess redirect semantics into the action error path).
async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}
