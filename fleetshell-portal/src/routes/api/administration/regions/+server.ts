import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { globalDb } from '$lib/server/db';

// Admin-gated type-ahead for the Grants scope builder.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
	const q = (url.searchParams.get('q') ?? '').trim();
	const like = '%' + q + '%';
	// Empty query = browse the top of the tree (lowest levels first).
	const filter = q ? globalDb`AND name ILIKE ${like}` : globalDb``;
	// `display` = the ancestor-name breadcrumb (World root dropped, level >= 2), e.g.
	// "North America / United States / Alabama" -- used as the picker label.
	const items = await globalDb<{ path: string; name: string; iso: string | null; level: number; display: string }[]>`
		SELECT r.path::text AS path, r.name, r.iso, r.level,
		       COALESCE(NULLIF((SELECT string_agg(a.name, ' / ' ORDER BY nlevel(a.path))
		                          FROM region a WHERE a.path @> r.path AND a.level >= 2), ''), r.name) AS display
		FROM region r
		WHERE true ${filter} ORDER BY r.level, r.name LIMIT 25`;
	return json({ items });
};
