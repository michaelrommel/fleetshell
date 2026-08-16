import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPersona } from '$lib/server/identity';
import { globalDb } from '$lib/server/db';

// Individual-system (device) bindings for one Info Proxy collection. The device
// set can be large (a collection may bind thousands of systems), so these are
// edited incrementally rather than replace-all:
//   GET    ?collection=&q=   search WITHIN the collection's bound devices
//   POST   {collection,device}   add a device binding
//   DELETE {collection,device}   remove a device binding
async function requireAdmin(locals: App.Locals) {
	if (!locals.userId) throw error(401, 'unauthenticated');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

export const GET: RequestHandler = async ({ url, locals }) => {
	await requireAdmin(locals);
	const collection = (url.searchParams.get('collection') ?? '').trim();
	const q = (url.searchParams.get('q') ?? '').trim();
	if (!collection) return json({ items: [] });

	// Each whitespace-separated term must match at least one of serial / IP /
	// functional location / hospital / product-model name -> progressive narrowing
	// (e.g. "X.cite 123032" = that model AND that serial).
	const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
	let cond = globalDb`TRUE`;
	for (const t of terms) {
		const like = '%' + t + '%';
		cond = globalDb`${cond} AND (
			d.serial ILIKE ${like} OR d.ip_address ILIKE ${like}
			OR d.functional_location ILIKE ${like} OR d.hospital_name ILIKE ${like}
			OR mp.name ILIKE ${like})`;
	}
	const items = await globalDb<{ id: string; serial: string; model: string }[]>`
		SELECT d.id::text AS id, COALESCE(d.serial, '') AS serial, COALESCE(mp.name, '') AS model
		FROM proxy_destination_binding b
		JOIN device d ON d.id = b.device_id
		LEFT JOIN product mp ON mp.path = d.product_path
		WHERE b.collection_id = ${collection} AND b.device_id IS NOT NULL AND ${cond}
		ORDER BY mp.name NULLS LAST, d.serial NULLS LAST LIMIT 100`;
	return json({ items });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	await requireAdmin(locals);
	const { collection, device } = await request.json();
	if (!collection || !device) throw error(400, 'collection and device required');
	await globalDb`INSERT INTO proxy_destination_binding (collection_id, device_id)
		VALUES (${collection}, ${device}) ON CONFLICT DO NOTHING`;
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	await requireAdmin(locals);
	const { collection, device } = await request.json();
	if (!collection || !device) throw error(400, 'collection and device required');
	await globalDb`DELETE FROM proxy_destination_binding
		WHERE collection_id = ${collection} AND device_id = ${device}`;
	return json({ ok: true });
};
