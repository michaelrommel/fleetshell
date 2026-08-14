import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { globalDb } from '$lib/server/db';

// Admin-gated type-ahead for gateways (device edit picker).
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ items: [] });
	const like = '%' + q + '%';
	const items = await globalDb<{ id: string; dns_name: string; label: string; region: string }[]>`
		SELECT id::text AS id, dns_name, label, region FROM gateway
		WHERE dns_name ILIKE ${like} OR label ILIKE ${like} OR region ILIKE ${like}
		ORDER BY dns_name LIMIT 25`;
	return json({ items });
};
