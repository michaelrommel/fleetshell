import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { globalDb } from '$lib/server/db';

// Admin-gated type-ahead for product MODELS (kind='model', nlevel 4) -- the
// device edit picker. Display decodes to 'modality / product / model'.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ items: [] });
	const like = '%' + q + '%';
	const items = await globalDb<{ id: string; path: string; name: string; display: string }[]>`
		SELECT p.id::text AS id, p.path::text AS path, p.name,
		  COALESCE((SELECT md.name FROM product md WHERE md.path = subltree(p.path, 0, 2)), '?')
		    || ' / ' || COALESCE((SELECT pr.name FROM product pr WHERE pr.path = subpath(p.path, 0, nlevel(p.path)-1)), '?')
		    || ' / ' || p.name AS display
		FROM product p
		WHERE p.kind = 'model' AND p.name ILIKE ${like}
		ORDER BY p.name LIMIT 25`;
	return json({ items });
};
