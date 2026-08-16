import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { spoolGatewayOnSave, deleteGatewayKeys } from '$lib/server/gateway_spool';

const PAGE_SIZE = 50;
const DEVICE_PREVIEW = 50;

// Google-style search over the RS-router (communication interface) fields.
const QUALIFIERS: Record<string, string[]> = {
	name: ['name'],
	hosp: ['hospital'],
	city: ['city'],
	ip:   ['public_ip'],
	admin: ['admin_ip', 'admin_ip2'],
};
const BARE_COLS = ['name', 'hospital', 'city', 'public_ip'];

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

function likeFrag(cols: string[], val: string) {
	let e = globalDb`FALSE`;
	for (const c of cols) e = globalDb`${e} OR g.${globalDb(c)} ILIKE ${val}`;
	return globalDb`(${e})`;
}
function buildWhere(query: string) {
	const tokens = query.trim().split(/\s+/).filter(Boolean);
	const frags = tokens.map((t) => {
		const m = t.match(/^([a-zA-Z]+):(.*)$/);
		const cols = m && QUALIFIERS[m[1].toLowerCase()];
		return cols ? likeFrag(cols, '%' + m![2] + '%') : likeFrag(BARE_COLS, '%' + t + '%');
	});
	if (!frags.length) return globalDb`TRUE`;
	let w = frags[0];
	for (let i = 1; i < frags.length; i++) w = globalDb`${w} AND ${frags[i]}`;
	return w;
}

type ListRow = {
	id: string; name: string | null; hospital: string; city: string | null; region: string;
	gateway_model: string | null; connection_type: string | null; operational_state: string | null;
	public_ip: string | null; device_count: number;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;

	const q = (url.searchParams.get('q') ?? '').trim();
	const sel = url.searchParams.get('sel');
	const isNew = isAdmin && url.searchParams.get('new') === '1';
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const after = url.searchParams.get('after');
	const before = url.searchParams.get('before');

	const where = buildWhere(q);

	let cursorFrag = globalDb``;
	let order = globalDb`g.id ASC`;
	let reverse = false;
	if (before) { cursorFrag = globalDb`AND g.id < ${before}`; order = globalDb`g.id DESC`; reverse = true; }
	else if (after) { cursorFrag = globalDb`AND g.id > ${after}`; }

	// Gateways are ~20k with no authz materialization, so the count is cheap:
	// compute it inline (parallel with the page query).
	const [fetchedRaw, cnt] = await Promise.all([
		globalDb<ListRow[]>`
			SELECT g.id::text AS id, g.name, g.hospital, g.city, g.region, g.gateway_model,
			       g.connection_type, g.operational_state, g.public_ip,
			       (SELECT count(*) FROM device d WHERE d.gateway_id = g.id)::int AS device_count
			FROM gateway g
			WHERE ${where} ${cursorFrag}
			ORDER BY ${order}
			LIMIT ${PAGE_SIZE + 1}`,
		globalDb<{ total: number }[]>`SELECT count(*)::int AS total FROM gateway g WHERE ${where}`,
	]);
	const total = cnt[0].total;

	const extra = fetchedRaw.length > PAGE_SIZE;
	let rows: ListRow[] = fetchedRaw.slice(0, PAGE_SIZE);
	if (reverse) rows = rows.reverse();

	const hasPrev = reverse ? extra : !!after;
	const hasNext = reverse ? true : extra;
	const from = (page - 1) * PAGE_SIZE + (rows.length ? 1 : 0);
	const to = (page - 1) * PAGE_SIZE + rows.length;

	// Detail + the attached-device list (the communication-interface <-> device relation).
	let detail: Record<string, unknown> | null = null;
	let devices: { id: string; serial: string | null; model: string | null; hospital: string | null; city: string | null }[] = [];
	let deviceTotal = 0;
	if (sel) {
		[detail] = await globalDb<Record<string, unknown>[]>`
			SELECT id::text AS id, hostname, region, hospital, name, city, gateway_model, connection_type,
			       operational_state, static_ip, nat_type, admin_ip, admin_ip2, country,
			       public_ip, psk, ipsec, tunnel_gateway, backend_access_ip, backend_sd_ip, backend_em_ip
			FROM gateway WHERE id = ${sel}`;
		if (detail) {
			[{ deviceTotal }] = await globalDb<{ deviceTotal: number }[]>`
				SELECT count(*)::int AS "deviceTotal" FROM device WHERE gateway_id = ${sel}`;
			devices = await globalDb<typeof devices>`
				SELECT d.id::text AS id, d.serial, m.name AS model, d.hospital_name AS hospital, d.city
				FROM device d LEFT JOIN product m ON m.path = d.product_path
				WHERE d.gateway_id = ${sel}
				ORDER BY d.serial NULLS LAST LIMIT ${DEVICE_PREVIEW}`;
		}
	}

	return {
		rows, total, q, isAdmin, page, from, to, hasPrev, hasNext,
		prevCursor: rows.length ? rows[0].id : null,
		nextCursor: rows.length ? rows[rows.length - 1].id : null,
		sel, isNew, detail, devices, deviceTotal, devicePreview: DEVICE_PREVIEW,
	};
};

function orNull(v: FormDataEntryValue | null): string | null {
	const s = String(v ?? '').trim();
	return s === '' ? null : s;
}
function fields(d: FormData) {
	return {
		hostname: orNull(d.get('hostname')),
		region: String(d.get('region') ?? '').trim(),
		hospital: String(d.get('hospital') ?? '').trim(),
		name: orNull(d.get('name')),
		city: orNull(d.get('city')),
		gateway_model: orNull(d.get('gateway_model')),
		connection_type: orNull(d.get('connection_type')),
		operational_state: orNull(d.get('operational_state')),
		nat_type: orNull(d.get('nat_type')),
		admin_ip: orNull(d.get('admin_ip')),
		admin_ip2: orNull(d.get('admin_ip2')),
		country: orNull(d.get('country')),
		tunnel_gateway: orNull(d.get('tunnel_gateway')),
		backend_access_ip: orNull(d.get('backend_access_ip')),
		backend_sd_ip: orNull(d.get('backend_sd_ip')),
		backend_em_ip: orNull(d.get('backend_em_ip')),
	};
}

// Parse the IPsec fields from the form (public_ip, psk, ipsec object). The ipsec
// value is the PARSED OBJECT, not a string: postgres.js serializes an object into
// jsonb correctly, whereas a pre-stringified JSON string gets double-encoded
// (stored as a jsonb string), which then breaks the fleetipsec:site spool.
function ipsecFields(d: FormData): { public_ip: string | null; psk: string | null; ipsec: object | null } | { error: string } {
	const public_ip = orNull(d.get('public_ip'));
	const psk = orNull(d.get('psk'));
	const raw = String(d.get('ipsec') ?? '').trim();
	let ipsec: object | null = null;
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') ipsec = parsed;
		} catch { return { error: 'Bad IPsec data.' }; }
	}
	return { public_ip, psk, ipsec };
}

export const actions: Actions = {
	updateGateway: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const f = fields(d);
		if (!id || !f.region) return fail(400, { error: 'Region is required.' });
		const sec = ipsecFields(d);
		if ('error' in sec) return fail(400, sec);
		const [prev] = await globalDb<{ public_ip: string | null }[]>`
			SELECT public_ip FROM gateway WHERE id = ${id}`;
		await globalDb`
			UPDATE gateway SET hostname = ${f.hostname}, region = ${f.region}, hospital = ${f.hospital},
				name = ${f.name}, city = ${f.city}, gateway_model = ${f.gateway_model},
				connection_type = ${f.connection_type}, operational_state = ${f.operational_state},
				nat_type = ${f.nat_type},
				admin_ip = ${f.admin_ip}, admin_ip2 = ${f.admin_ip2}, country = ${f.country},
				tunnel_gateway = ${f.tunnel_gateway},
				backend_access_ip = ${f.backend_access_ip}, backend_sd_ip = ${f.backend_sd_ip}, backend_em_ip = ${f.backend_em_ip},
				public_ip = ${sec.public_ip}, psk = ${sec.psk}, ipsec = ${sec.ipsec === null ? null : globalDb.json(sec.ipsec as Parameters<typeof globalDb.json>[0])}
			WHERE id = ${id}`;
		try {
			await spoolGatewayOnSave(id, prev?.public_ip ?? null);
		} catch (e) {
			console.error('[spool] gateway update:', (e as Error).message);
		}
		throw redirect(303, `${base}/gateways?sel=${encodeURIComponent(id)}`);
	},

	createGateway: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const f = fields(d);
		if (!f.region) return fail(400, { error: 'Region is required.' });
		const sec = ipsecFields(d);
		if ('error' in sec) return fail(400, sec);
		const [row] = await globalDb<{ id: string }[]>`
			INSERT INTO gateway (hostname, region, hospital, name, city, gateway_model, connection_type,
				operational_state, nat_type, admin_ip, admin_ip2, country, public_ip, psk, ipsec,
				tunnel_gateway, backend_access_ip, backend_sd_ip, backend_em_ip)
			VALUES (${f.hostname}, ${f.region}, ${f.hospital}, ${f.name}, ${f.city}, ${f.gateway_model},
				${f.connection_type}, ${f.operational_state}, ${f.nat_type},
				${f.admin_ip}, ${f.admin_ip2}, ${f.country}, ${sec.public_ip}, ${sec.psk}, ${sec.ipsec === null ? null : globalDb.json(sec.ipsec as Parameters<typeof globalDb.json>[0])},
				${f.tunnel_gateway}, ${f.backend_access_ip}, ${f.backend_sd_ip}, ${f.backend_em_ip})
			RETURNING id::text AS id`;
		try {
			await spoolGatewayOnSave(row.id, null);
		} catch (e) {
			console.error('[spool] gateway create:', (e as Error).message);
		}
		throw redirect(303, `${base}/gateways?sel=${encodeURIComponent(row.id)}`);
	},

	deleteGateway: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Gateway id required.' });
		const [{ n }] = await globalDb<{ n: number }[]>`SELECT count(*)::int AS n FROM device WHERE gateway_id = ${id}`;
		if (n > 0) return fail(400, { error: `${n} device(s) use this interface; reassign them first.` });
		const [g] = await globalDb<{ public_ip: string | null }[]>`SELECT public_ip FROM gateway WHERE id = ${id}`;
		await globalDb`DELETE FROM gateway WHERE id = ${id}`;
		try {
			if (g?.public_ip) await deleteGatewayKeys(g.public_ip);
		} catch (e) {
			console.error('[spool] gateway delete:', (e as Error).message);
		}
		throw redirect(303, `${base}/gateways`);
	},
};
