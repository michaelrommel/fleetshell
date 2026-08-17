import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { globalDb } from '$lib/server/db';

// GET /api/administration/groups?q=<label>
// Type-ahead for the persona membership editor. Admin personas only.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');

	const q = (url.searchParams.get('q') ?? '').trim();
	// Empty query = browse the root groups (top of the tree; excludes legacy
	// per-user grant holders).
	const filter = q
		? globalDb`AND label ILIKE ${'%' + q + '%'}`
		: globalDb`AND parent_id IS NULL AND label NOT LIKE 'user:%'`;
	const groups = await globalDb<{ group_id: string; label: string; path: string | null }[]>`
		SELECT group_id, label, path::text AS path
		FROM principal_group
		WHERE true ${filter}
		ORDER BY label
		LIMIT 25
	`;
	return json({ groups });
};
