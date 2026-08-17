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
	// Empty query = browse the first sites alphabetically.
	const filter = q ? globalDb`AND s.name ILIKE ${like}` : globalDb``;
	const items = await globalDb<{ id: string; name: string; customer_name: string }[]>`
		SELECT s.id::text AS id, s.name, c.name AS customer_name
		FROM customer_site s JOIN customer c ON c.id = s.customer_id
		WHERE true ${filter} ORDER BY s.name LIMIT 25`;
	return json({ items });
};
