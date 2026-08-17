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
	const items = await globalDb<{ path: string; name: string; iso: string | null; level: number }[]>`
		SELECT path::text AS path, name, iso, level FROM region
		WHERE true ${filter} ORDER BY level, name LIMIT 25`;
	return json({ items });
};
