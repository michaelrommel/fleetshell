import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { listCountries, listVariants } from '$lib/server/dtm';

const LIST_LIMIT = 200;
const MEMBER_PREVIEW = 500;   // > observed max (128) so the manual list is fully editable

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

const orNull = (v: FormDataEntryValue | null): string | null => {
	const s = String(v ?? '').trim();
	return s === '' ? null : s;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;

	const q = (url.searchParams.get('q') ?? '').trim();
	const sel = url.searchParams.get('sel');       // customer id
	const siteId = url.searchParams.get('site');   // site id
	const isNew = isAdmin && url.searchParams.get('new') === '1';         // new customer
	const newSite = isAdmin && url.searchParams.get('newsite') === '1';   // new site under sel

	const [countries, variants] = await Promise.all([listCountries(), listVariants()]);

	const like = '%' + q + '%';
	const [rows, cnt] = await Promise.all([
		q
			? globalDb<{ id: string; name: string; country: string; city: string | null; site_count: number; device_count: number }[]>`
				SELECT c.id::text AS id, c.name, c.country, c.city,
				  (SELECT count(*) FROM customer_site s WHERE s.customer_id = c.id)::int AS site_count,
				  (SELECT count(*) FROM device d WHERE d.customer_id = c.id)::int AS device_count
				FROM customer c
				WHERE c.name ILIKE ${like} OR c.country ILIKE ${like} OR c.city ILIKE ${like}
				ORDER BY c.name LIMIT ${LIST_LIMIT}`
			: globalDb<{ id: string; name: string; country: string; city: string | null; site_count: number; device_count: number }[]>`
				SELECT c.id::text AS id, c.name, c.country, c.city,
				  (SELECT count(*) FROM customer_site s WHERE s.customer_id = c.id)::int AS site_count,
				  (SELECT count(*) FROM device d WHERE d.customer_id = c.id)::int AS device_count
				FROM customer c ORDER BY c.name LIMIT ${LIST_LIMIT}`,
		globalDb<{ total: number }[]>`
			SELECT count(*)::int AS total FROM customer c
			${q ? globalDb`WHERE c.name ILIKE ${like} OR c.country ILIKE ${like} OR c.city ILIKE ${like}` : globalDb``}`,
	]);

	// Customer detail + its sites.
	let customer: Record<string, unknown> | null = null;
	let sites: { id: string; name: string; country: string; city: string | null; device_count: number }[] = [];
	if (sel) {
		[customer] = await globalDb<Record<string, unknown>[]>`
			SELECT id::text AS id, name, country, city, postcode, street,
			       requires_explicit_grant, dtm_variant
			FROM customer WHERE id = ${sel}`;
		if (customer) {
			sites = await globalDb<typeof sites>`
				SELECT s.id::text AS id, s.name, s.country, s.city,
				  (SELECT count(*) FROM device d WHERE d.site_id = s.id)::int AS device_count
				FROM customer_site s WHERE s.customer_id = ${sel} ORDER BY s.name`;
		}
	}

	// Site detail: fields, contacts, membership (gateway rule / hospital rule /
	// manual static members), and the effective (materialized) device count.
	let site: Record<string, unknown> | null = null;
	let contacts: Record<string, unknown>[] = [];
	let gatewayChips: { key: string; label: string }[] = [];
	let hospitalNames: string[] = [];
	let members: { id: string; serial: string; model: string; product: string }[] = [];
	let memberTotal = 0;
	let effectiveCount = 0;
	if (siteId) {
		[site] = await globalDb<Record<string, unknown>[]>`
			SELECT id::text AS id, customer_id::text AS customer_id, name, country, city, postcode, street,
			       requires_explicit_grant
			FROM customer_site WHERE id = ${siteId}`;
		if (site) {
			contacts = await globalDb<Record<string, unknown>[]>`
				SELECT id::text AS id, name, role, email, phone, note
				FROM customer_site_contact WHERE site_id = ${siteId} ORDER BY sort_order, name`;
			const [gwRule] = await globalDb<{ values: string[] }[]>`
				SELECT values FROM customer_site_rule WHERE site_id = ${siteId} AND dimension = 'gateway_id'`;
			if (gwRule?.values?.length) {
				gatewayChips = await globalDb<{ key: string; label: string }[]>`
					SELECT id::text AS key, COALESCE(name, hostname, id::text) AS label
					FROM gateway WHERE id::text = ANY(${gwRule.values}) ORDER BY label`;
			}
			const [hostRule] = await globalDb<{ values: string[] }[]>`
				SELECT values FROM customer_site_rule WHERE site_id = ${siteId} AND dimension = 'hospital_name'`;
			hospitalNames = hostRule?.values ?? [];
			[{ memberTotal }] = await globalDb<{ memberTotal: number }[]>`
				SELECT count(*)::int AS "memberTotal" FROM customer_site_member_static WHERE site_id = ${siteId}`;
			members = await globalDb<{ id: string; serial: string; model: string; product: string }[]>`
				SELECT d.id::text AS id, COALESCE(d.serial, '') AS serial,
				  COALESCE((SELECT name FROM product WHERE path = d.product_path), '') AS model,
				  COALESCE((SELECT name FROM product WHERE nlevel(d.product_path) >= 2
				            AND path = subpath(d.product_path, 0, nlevel(d.product_path) - 1)), '') AS product
				FROM customer_site_member_static m JOIN device d ON d.id = m.device_id
				WHERE m.site_id = ${siteId} ORDER BY d.serial NULLS LAST LIMIT ${MEMBER_PREVIEW}`;
			[{ effectiveCount }] = await globalDb<{ effectiveCount: number }[]>`
				SELECT count(*)::int AS "effectiveCount" FROM device WHERE site_id = ${siteId}`;
		}
	}

	return {
		isAdmin, q, rows, total: cnt[0].total, listLimit: LIST_LIMIT,
		countries, variants,
		sel, isNew, customer, sites,
		siteId, newSite, site, contacts, gatewayChips, hospitalNames,
		members, memberTotal, memberPreview: MEMBER_PREVIEW, effectiveCount,
	};
};

const custHref = (id: string) => `${base}/customers?sel=${encodeURIComponent(id)}`;
const siteHref = (cid: string, sid: string) =>
	`${base}/customers?sel=${encodeURIComponent(cid)}&site=${encodeURIComponent(sid)}`;

export const actions: Actions = {
	// --- customer ------------------------------------------------------------
	createCustomer: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const name = String(d.get('name') ?? '').trim();
		const country = String(d.get('country') ?? '').trim();
		if (!name || !country) return fail(400, { error: 'Name and country are required.' });
		const [row] = await globalDb<{ id: string }[]>`
			INSERT INTO customer (name, country, city, postcode, street, requires_explicit_grant, dtm_variant)
			VALUES (${name}, ${country}, ${orNull(d.get('city'))}, ${orNull(d.get('postcode'))},
			        ${orNull(d.get('street'))}, ${d.get('requires_explicit_grant') === 'on'},
			        ${orNull(d.get('dtm_variant'))})
			RETURNING id::text AS id`;
		throw redirect(303, custHref(row.id));
	},
	updateCustomer: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		const country = String(d.get('country') ?? '').trim();
		if (!id || !name || !country) return fail(400, { error: 'Name and country are required.' });
		await globalDb`
			UPDATE customer SET name = ${name}, country = ${country}, city = ${orNull(d.get('city'))},
				postcode = ${orNull(d.get('postcode'))}, street = ${orNull(d.get('street'))},
				requires_explicit_grant = ${d.get('requires_explicit_grant') === 'on'},
				dtm_variant = ${orNull(d.get('dtm_variant'))}
			WHERE id = ${id}`;
		throw redirect(303, custHref(id));
	},
	deleteCustomer: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		if (!id) return fail(400, { error: 'Customer id required.' });
		const [{ n }] = await globalDb<{ n: number }[]>`SELECT count(*)::int AS n FROM device WHERE customer_id = ${id}`;
		if (n > 0) return fail(400, { error: `${n} device(s) reference this customer; reassign them first.` });
		await globalDb`DELETE FROM customer WHERE id = ${id}`;   // sites cascade
		throw redirect(303, `${base}/customers`);
	},

	// --- site ----------------------------------------------------------------
	createSite: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const customer_id = String(d.get('customer_id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		const country = String(d.get('country') ?? '').trim();
		if (!customer_id || !name || !country) return fail(400, { error: 'Name and country are required.' });
		const [row] = await globalDb<{ id: string }[]>`
			INSERT INTO customer_site (customer_id, name, country, city, postcode, street, requires_explicit_grant)
			VALUES (${customer_id}, ${name}, ${country}, ${orNull(d.get('city'))}, ${orNull(d.get('postcode'))},
			        ${orNull(d.get('street'))}, ${d.get('requires_explicit_grant') === 'on'})
			RETURNING id::text AS id`;
		throw redirect(303, siteHref(customer_id, row.id));
	},
	updateSite: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const customer_id = String(d.get('customer_id') ?? '');
		const name = String(d.get('name') ?? '').trim();
		const country = String(d.get('country') ?? '').trim();
		if (!id || !name || !country) return fail(400, { error: 'Name and country are required.' });
		await globalDb`
			UPDATE customer_site SET name = ${name}, country = ${country}, city = ${orNull(d.get('city'))},
				postcode = ${orNull(d.get('postcode'))}, street = ${orNull(d.get('street'))},
				requires_explicit_grant = ${d.get('requires_explicit_grant') === 'on'}
			WHERE id = ${id}`;
		throw redirect(303, siteHref(customer_id, id));
	},
	deleteSite: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = String(d.get('id') ?? '');
		const customer_id = String(d.get('customer_id') ?? '');
		if (!id) return fail(400, { error: 'Site id required.' });
		await globalDb`DELETE FROM customer_site WHERE id = ${id}`;   // rules/members/contacts cascade
		await globalDb`SELECT resolve_site_membership()`;            // devices lose this site
		throw redirect(303, custHref(customer_id));
	},

	// --- site contacts (replace-all) -----------------------------------------
	saveContacts: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const siteId = String(d.get('site_id') ?? '');
		const customer_id = String(d.get('customer_id') ?? '');
		if (!siteId) return fail(400, { error: 'Site required.' });
		let raw: unknown;
		try { raw = JSON.parse(String(d.get('contacts') ?? '[]')); } catch { return fail(400, { error: 'Bad contact data.' }); }
		if (!Array.isArray(raw)) return fail(400, { error: 'Bad contact data.' });
		const rows = (raw as Record<string, unknown>[])
			.map((c) => ({
				name: String(c.name ?? '').trim(), role: String(c.role ?? '').trim(),
				email: String(c.email ?? '').trim(), phone: String(c.phone ?? '').trim(),
				note: String(c.note ?? '').trim(),
			}))
			.filter((c) => c.name || c.email || c.phone);
		await globalDb.begin(async (sql) => {
			await sql`DELETE FROM customer_site_contact WHERE site_id = ${siteId}`;
			for (let i = 0; i < rows.length; i++) {
				const c = rows[i];
				await sql`
					INSERT INTO customer_site_contact (site_id, name, role, email, phone, note, sort_order)
					VALUES (${siteId}, ${c.name}, ${c.role || null}, ${c.email || null}, ${c.phone || null}, ${c.note || null}, ${i})`;
			}
		});
		throw redirect(303, siteHref(customer_id, siteId));
	},

	// --- site membership (gateway rule + hospital rule + manual devices) ------
	saveMembership: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const siteId = String(d.get('site_id') ?? '');
		const customer_id = String(d.get('customer_id') ?? '');
		if (!siteId) return fail(400, { error: 'Site required.' });

		const parseArr = (key: string): string[] => {
			try { const v = JSON.parse(String(d.get(key) ?? '[]')); return Array.isArray(v) ? v.map(String) : []; }
			catch { return []; }
		};
		const gateways = [...new Set(parseArr('gateways').map((s) => s.trim()).filter(Boolean))];
		const hospitals = [...new Set(parseArr('hospitals').map((s) => s.trim()).filter(Boolean))];
		const devices = [...new Set(parseArr('devices').map((s) => s.trim()).filter(Boolean))];

		await globalDb.begin(async (sql) => {
			// gateway_id rule
			if (gateways.length) {
				await sql`
					INSERT INTO customer_site_rule (site_id, dimension, values)
					VALUES (${siteId}, 'gateway_id', ${gateways})
					ON CONFLICT (site_id, dimension) DO UPDATE SET values = EXCLUDED.values`;
			} else {
				await sql`DELETE FROM customer_site_rule WHERE site_id = ${siteId} AND dimension = 'gateway_id'`;
			}
			// hospital_name rule
			if (hospitals.length) {
				await sql`
					INSERT INTO customer_site_rule (site_id, dimension, values)
					VALUES (${siteId}, 'hospital_name', ${hospitals})
					ON CONFLICT (site_id, dimension) DO UPDATE SET values = EXCLUDED.values`;
			} else {
				await sql`DELETE FROM customer_site_rule WHERE site_id = ${siteId} AND dimension = 'hospital_name'`;
			}
			// manual static members
			await sql`DELETE FROM customer_site_member_static WHERE site_id = ${siteId}`;
			for (const dev of devices) {
				await sql`
					INSERT INTO customer_site_member_static (site_id, device_id) VALUES (${siteId}, ${dev})
					ON CONFLICT DO NOTHING`;
			}
		});
		await globalDb`SELECT resolve_site_membership()`;
		throw redirect(303, siteHref(customer_id, siteId));
	},
};
