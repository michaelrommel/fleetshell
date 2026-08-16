import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { globalDb } from '$lib/server/db';

// Admin-gated type-ahead over kind='product' nodes, returning the product UUID
// (idField) plus a "Modality / Product" display. Used by the File Subscriptions
// editor, whose subscription.product_id is a product FK (not an ltree path).
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ items: [] });
	const mod = (url.searchParams.get('mod') ?? '').trim() || null;
	const like = '%' + q + '%';
	const items = await globalDb<{ id: string; name: string; display: string }[]>`
		SELECT p.id::text AS id, p.name,
		  COALESCE((SELECT tp.name FROM product tp
		            WHERE tp.path = subltree(p.path, 0, LEAST(nlevel(p.path), 2))), p.name)
		    || ' / ' || p.name AS display
		FROM product p
		WHERE p.kind = 'product' AND p.name ILIKE ${like} AND p.name <> ''
		  ${mod ? globalDb`AND p.path <@ (SELECT path FROM product WHERE id = ${mod})` : globalDb``}
		ORDER BY p.name LIMIT 25`;
	return json({ items });
};
