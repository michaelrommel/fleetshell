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
	if (q.length < 2) return json({ items: [] });
	const like = '%' + q + '%';
	const items = await globalDb<{ path: string; name: string; display: string }[]>`
		SELECT p.path::text AS path, p.name,
		  COALESCE((SELECT tp.name FROM product tp WHERE tp.path = subltree(p.path, 0, LEAST(nlevel(p.path), 2))), p.name)
		    || ' / ' || CASE WHEN nlevel(p.path) <= 2 THEN 'ANY' ELSE p.name END AS display
		FROM product p
		WHERE p.name ILIKE ${like} AND p.name <> '' AND nlevel(p.path) <= 3 ORDER BY p.name LIMIT 25`;
	return json({ items });
};
