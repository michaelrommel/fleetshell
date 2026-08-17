import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { globalDb } from '$lib/server/db';

// Admin-gated type-ahead for the Grants scope builder (service subtree scopes).
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
	const q = (url.searchParams.get('q') ?? '').trim();
	const like = '%' + q + '%';
	// Empty query = browse the categories (top of the service tree). A text query
	// matches a node OR any of its ancestors, so typing a category name ('remote')
	// surfaces the category AND every function beneath it (Screen Recording, ...).
	const filter = q
		? globalDb`AND EXISTS (SELECT 1 FROM service a
				WHERE s.path <@ a.path AND a.kind <> 'root' AND a.name ILIKE ${like})`
		: globalDb`AND s.kind = 'category'`;
	// Ancestor category name prefixes the label so 'Remote Access / Screen Recording'
	// disambiguates the two 'Remote Access' nodes.
	const items = await globalDb<{ path: string; name: string; kind: string; parent_name: string | null }[]>`
		SELECT s.path::text AS path, s.name, s.kind,
		  (SELECT p.name FROM service p
		     WHERE p.path = subpath(s.path, 0, nlevel(s.path) - 1) AND nlevel(p.path) >= 2) AS parent_name
		FROM service s
		WHERE s.kind <> 'root' ${filter}
		ORDER BY nlevel(s.path), s.name LIMIT 25`;
	return json({ items });
};
