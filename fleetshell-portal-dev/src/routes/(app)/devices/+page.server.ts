import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { resolveGroupIds } from '$lib/server/authz';
import { buildDeviceWhere } from '$lib/server/deviceQuery';

const PAGE_SIZE = 50;

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

type ListRow = {
	id: string; serial: string | null; functional_location: string | null; ip_address: string | null;
	technical_ident: string | null; hospital_name: string | null; country_iso: string | null;
	access_requirement: string; model_name: string | null; product_name: string | null;
	customer_name: string | null; gateway: string | null; city: string | null; partno: string | null;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) return { devices: [], total: 0, q: '', mode: 'scope', isAdmin: false,
		page: 1, from: 0, to: 0, hasPrev: false, hasNext: false, prevCursor: null, nextCursor: null,
		sel: null, isNew: false, detail: null };
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;

	const q = (url.searchParams.get('q') ?? '').trim();
	const mode = isAdmin && url.searchParams.get('mode') === 'all' ? 'all' : 'scope';
	const sel = url.searchParams.get('sel');
	const isNew = isAdmin && url.searchParams.get('new') === '1';
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const after = url.searchParams.get('after');
	const before = url.searchParams.get('before');
	// Count carried through pagination links (approach A): present -> reuse (no
	// recompute); absent (filter changed) -> null, the client fetches /count.
	const carried = url.searchParams.get('n');
	const total: number | null = carried !== null && /^\d+$/.test(carried) ? Number(carried) : null;

	const where = buildDeviceWhere(q);

	// Keyset over id (stable; updated_at is uniform post-import so not usable).
	let cursorFrag = globalDb``;
	let order = globalDb`d.id ASC`;
	let reverse = false;
	if (before) { cursorFrag = globalDb`AND d.id < ${before}`; order = globalDb`d.id DESC`; reverse = true; }
	else if (after) { cursorFrag = globalDb`AND d.id > ${after}`; }

	// Shared projection + name joins (nested fragments).
	const cols = globalDb`d.id::text AS id, d.serial, d.functional_location, d.ip_address, d.technical_ident,
		d.hospital_name, d.country_iso, d.access_requirement, d.city, m.name AS model_name, pm.partno::text AS partno,
		(SELECT pr.name FROM product pr WHERE pr.path = subpath(d.product_path, 0, nlevel(d.product_path) - 1)) AS product_name,
		       cu.name AS customer_name, COALESCE(gw.name, gw.hostname) AS gateway`;
	const joins = globalDb`
		LEFT JOIN product m        ON m.path = d.product_path
		LEFT JOIN product_model pm ON pm.product_id = m.id
		LEFT JOIN customer cu ON cu.id = d.customer_id
		LEFT JOIN gateway gw  ON gw.id = d.gateway_id`;

	// 'scope' joins the tuned visible-id set (authz_fastpath, 128MB work_mem);
	// 'all' (admin) reads the table directly on the id PK. Only the page query
	// runs here -- the total is threaded via the URL or fetched by the client.
	let fetched: ListRow[];
	if (mode === 'all') {
		fetched = await globalDb<ListRow[]>`SELECT ${cols} FROM device d ${joins}
			WHERE ${where} ${cursorFrag} ORDER BY ${order} LIMIT ${PAGE_SIZE + 1}`;
	} else {
		const groupIds = await resolveGroupIds(locals.userId);
		if (!groupIds.length) {
			return { devices: [], total: 0, q, mode, isAdmin, page: 1, from: 0, to: 0,
				hasPrev: false, hasNext: false, prevCursor: null, nextCursor: null,
				sel, isNew, detail: await loadDetail(sel) };
		}
		fetched = await globalDb<ListRow[]>`SELECT ${cols}
			FROM device d JOIN authz_visible_device_ids(${groupIds}::uuid[], 'view') v ON v.id = d.id ${joins}
			WHERE ${where} ${cursorFrag} ORDER BY ${order} LIMIT ${PAGE_SIZE + 1}`;
	}

	const extra = fetched.length > PAGE_SIZE;
	let rows: ListRow[] = fetched.slice(0, PAGE_SIZE);
	if (reverse) rows = rows.reverse();

	const hasPrev = reverse ? extra : !!after;
	const hasNext = reverse ? true : extra;
	const from = (page - 1) * PAGE_SIZE + (rows.length ? 1 : 0);
	const to = (page - 1) * PAGE_SIZE + rows.length;

	return {
		devices: rows, total, q, mode, isAdmin, page, from, to,
		hasPrev, hasNext,
		prevCursor: rows.length ? rows[0].id : null,
		nextCursor: rows.length ? rows[rows.length - 1].id : null,
		sel, isNew, detail: await loadDetail(sel),
	};
};

async function loadDetail(sel: string | null) {
	if (!sel) return null;
	const [d] = await globalDb<Record<string, unknown>[]>`
		SELECT d.id::text AS id, d.serial, d.functional_location, d.technical_ident, d.host_hw_id,
		       d.order_number, d.ip_address, d.ip_real, d.contact, d.city, d.hospital_name, d.software_version,
		       d.access_requirement, d.country_iso, d.tunnel_gateway,
		       d.product_path::text AS product_path, d.region_path::text AS region_path,
		       d.customer_id::text AS customer_id, d.site_id::text AS site_id, d.gateway_id::text AS gateway_id,
		       m.name AS model_name, pm.partno::text AS model_partno,
		       (SELECT pr.name FROM product pr WHERE pr.path = subpath(d.product_path, 0, nlevel(d.product_path) - 1)) AS product_name,
		       (SELECT md.name FROM product md WHERE md.path = subltree(d.product_path, 0, 2)) AS modality_name,
		       reg.name AS region_name, cu.name AS customer_name, si.name AS site_name,
		       gw.hostname AS gateway_dns, COALESCE(gw.name, gw.hostname) AS gateway_name, gw.hospital AS gateway_label
		FROM device d
		LEFT JOIN product m        ON m.path = d.product_path
		LEFT JOIN product_model pm ON pm.product_id = m.id
		LEFT JOIN region reg       ON reg.path = d.region_path
		LEFT JOIN customer cu      ON cu.id = d.customer_id
		LEFT JOIN customer_site si ON si.id = d.site_id
		LEFT JOIN gateway gw       ON gw.id = d.gateway_id
		WHERE d.id = ${sel}`;
	if (!d) return null;
	// Effective apps for this device = the model's product_model_app (inherited).
	// Per-device override (device_app) is a later slice; read-only for now.
	const apps = await globalDb<Record<string, unknown>[]>`
		SELECT pma.name, pma.application, pma.ports, pma.guac, pma.e2ecrypt, pma.sni, pma.path,
		       pma.width, pma.height, pma.dpi, pma.drive, pma.record
		FROM product_model_app pma
		JOIN product m ON m.id = pma.product_id
		WHERE m.path = ${d.product_path as string}::ltree
		ORDER BY pma.sort_order, pma.name`;
	return { ...d, apps };
}

// Empty string -> null (for nullable uuid/ltree columns).
function orNull(v: FormDataEntryValue | null): string | null {
	const s = String(v ?? '').trim();
	return s === '' ? null : s;
}

function editFields(d: FormData) {
	return {
		serial: orNull(d.get('serial')),
		functional_location: orNull(d.get('functional_location')),
		technical_ident: orNull(d.get('technical_ident')),
		host_hw_id: orNull(d.get('host_hw_id')),
		order_number: orNull(d.get('order_number')),
		ip_address: orNull(d.get('ip_address')),
		ip_real: orNull(d.get('ip_real')),
		contact: orNull(d.get('contact')),
		hospital_name: orNull(d.get('hospital_name')),
		city: orNull(d.get('city')),
		software_version: orNull(d.get('software_version')),
		access_requirement: ['open', 'device', 'customer', 'site'].includes(String(d.get('access_requirement')))
			? String(d.get('access_requirement')) : 'open',
		product_path: orNull(d.get('product_path')),
		region_path: orNull(d.get('region_path')),
		gateway_id: orNull(d.get('gateway_id')),
		tunnel_gateway: orNull(d.get('tunnel_gateway')),
	};
}

export const actions: Actions = {
	updateDevice: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Device id required.' });
		const f = editFields(d);
		// modality + country_iso are denormalized; recompute from the picks.
		await globalDb`
			UPDATE device SET
				serial = ${f.serial}, functional_location = ${f.functional_location},
				technical_ident = ${f.technical_ident}, host_hw_id = ${f.host_hw_id},
				order_number = ${f.order_number}, ip_address = ${f.ip_address}, ip_real = ${f.ip_real},
				contact = ${f.contact}, hospital_name = ${f.hospital_name}, city = ${f.city}, software_version = ${f.software_version},
				access_requirement = ${f.access_requirement},
				product_path = ${f.product_path}::ltree,
				modality = (SELECT md.name FROM product md WHERE md.path = subltree(${f.product_path}::ltree, 0, 2)),
				region_path = ${f.region_path}::ltree,
				country_iso = (SELECT iso FROM region WHERE path = ${f.region_path}::ltree),
				gateway_id = ${f.gateway_id}::uuid, tunnel_gateway = ${f.tunnel_gateway}, updated_at = now()
			WHERE id = ${id}`;
		const tab = String(d.get('tab') ?? '').trim();
		const tabQ = tab ? `&tab=${encodeURIComponent(tab)}` : '';
		throw redirect(303, `${base}/devices?sel=${encodeURIComponent(id)}${tabQ}`);
	},

	createDevice: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const f = editFields(d);
		const [row] = await globalDb<{ id: string }[]>`
			INSERT INTO device (serial, functional_location, technical_ident, host_hw_id, order_number,
				ip_address, ip_real, contact, hospital_name, city, software_version, access_requirement,
				product_path, modality, region_path, country_iso, gateway_id, tunnel_gateway)
			VALUES (${f.serial}, ${f.functional_location}, ${f.technical_ident}, ${f.host_hw_id}, ${f.order_number},
				${f.ip_address}, ${f.ip_real}, ${f.contact}, ${f.hospital_name}, ${f.city}, ${f.software_version}, ${f.access_requirement},
				${f.product_path}::ltree,
				(SELECT md.name FROM product md WHERE md.path = subltree(${f.product_path}::ltree, 0, 2)),
				${f.region_path}::ltree,
				(SELECT iso FROM region WHERE path = ${f.region_path}::ltree),
				${f.gateway_id}::uuid, ${f.tunnel_gateway})
			RETURNING id::text AS id`;
		throw redirect(303, `${base}/devices?sel=${encodeURIComponent(row.id)}`);
	},

	deleteDevice: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Device id required.' });
		// authz_scope_device has no FK cascade -> block if a single-system grant names it.
		const [{ n }] = await globalDb<{ n: number }[]>`
			SELECT count(*)::int AS n FROM authz_scope_device WHERE device_id = ${id}`;
		if (n > 0) return fail(400, { error: `Referenced by ${n} single-system grant(s); revoke those first.` });
		await globalDb`DELETE FROM device WHERE id = ${id}`;   // customer_site_member_static cascades
		throw redirect(303, `${base}/devices`);
	},
};
