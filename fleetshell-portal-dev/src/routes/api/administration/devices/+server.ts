import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { globalDb } from '$lib/server/db';

// Admin-gated type-ahead for devices (customer-site "customer systems" picker).
// Matches on serial / IP / functional location / hospital.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ items: [] });
	const like = '%' + q + '%';
	const items = await globalDb<{ id: string; serial: string; ip: string; model: string; product: string }[]>`
		SELECT d.id::text AS id, COALESCE(d.serial, '') AS serial, COALESCE(d.ip_address, '') AS ip,
		       COALESCE((SELECT name FROM product WHERE path = d.product_path), '') AS model,
		       COALESCE((SELECT name FROM product WHERE nlevel(d.product_path) >= 2
		                 AND path = subpath(d.product_path, 0, nlevel(d.product_path) - 1)), '') AS product
		FROM device d
		WHERE d.serial ILIKE ${like} OR d.ip_address ILIKE ${like}
		   OR d.functional_location ILIKE ${like} OR d.hospital_name ILIKE ${like}
		ORDER BY d.serial NULLS LAST LIMIT 25`;
	return json({ items });
};
