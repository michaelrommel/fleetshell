import type { PageServerLoad, Actions } from './$types';
import { fail, error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { globalDb } from '$lib/server/db';
import { getPersona } from '$lib/server/identity';
import { listCountries } from '$lib/server/dtm';

// File Subscriptions is master data authored by administrators. Phase 1 uses the
// interim is_admin gate, like the rest of the portal-dev sections.
async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) throw error(403, 'forbidden');
}

const orNull = (v: FormDataEntryValue | null): string | null => {
	const s = String(v ?? '').trim();
	return s === '' ? null : s;
};

type View = 'servers' | 'subscriptions';

type ServerRow = {
	id: string; name: string; ip_address: string | null; country: string | null; use_case: string;
	activated: boolean; delivery_method: string; sub_count: number;
};
type SubRow = {
	id: string; name: string; pattern: string; negate: boolean;
	modality_name: string | null; product_name: string | null; server_count: number;
};

/** Build the method-specific auth jsonb from posted fields (secrets plaintext). */
function buildAuth(delivery: string, d: FormData): Record<string, string | null> {
	if (delivery === 'adls') {
		const m = orNull(d.get('adls_method')) ?? 'service_principal';
		return m === 'default'
			? { method: 'default',
			    account_url: orNull(d.get('account_url')),
			    account_name: orNull(d.get('account_name')),
			    account_key: orNull(d.get('account_key')) }
			: { method: 'service_principal',
			    storage_account: orNull(d.get('storage_account')),
			    tenant_id: orNull(d.get('tenant_id')),
			    client_id: orNull(d.get('client_id')),
			    client_secret: orNull(d.get('client_secret')) };
	}
	if (delivery === 's3') {
		const m = orNull(d.get('s3_method')) ?? 'access_key';
		return m === 'assume_role'
			? { method: 'assume_role',
			    role_arn: orNull(d.get('role_arn')),
			    external_id: orNull(d.get('external_id')),
			    region: orNull(d.get('region')) }
			: { method: 'access_key',
			    access_key_id: orNull(d.get('access_key_id')),
			    secret_access_key: orNull(d.get('secret_access_key')),
			    region: orNull(d.get('region')),
			    endpoint: orNull(d.get('endpoint')) };
	}
	// scp
	return { username: orNull(d.get('username')), password: orNull(d.get('password')) };
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.userId) throw redirect(303, `${base}/login`);
	const persona = await getPersona(locals.userId);
	const isAdmin = persona?.is_admin ?? false;

	const view = (url.searchParams.get('view') || 'servers') as View;
	const sel = url.searchParams.get('sel');
	const isNew = isAdmin && url.searchParams.get('new') === '1';

	const [countries, modalities] = await Promise.all([
		listCountries(),
		globalDb<{ id: string; name: string }[]>`
			SELECT id::text AS id, name FROM product
			WHERE kind = 'modality' AND name <> '' ORDER BY name`,
	]);

	const servers = await globalDb<ServerRow[]>`
		SELECT s.id::text AS id, s.name, s.ip_address, s.country, s.use_case, s.activated, s.delivery_method,
		       (SELECT count(*) FROM subscription_server ss WHERE ss.server_id = s.id)::int AS sub_count
		FROM subscriber_server s ORDER BY s.name`;

	const subscriptions = await globalDb<SubRow[]>`
		SELECT sub.id::text AS id, sub.name, sub.pattern, sub.negate,
		       m.name AS modality_name, p.name AS product_name,
		       (SELECT count(*) FROM subscription_server ss WHERE ss.subscription_id = sub.id)::int AS server_count
		FROM subscription sub
		LEFT JOIN product m ON m.id = sub.modality_id
		LEFT JOIN product p ON p.id = sub.product_id
		ORDER BY sub.name`;

	// Selected detail (per view) + its attachments.
	let server: Record<string, unknown> | null = null;
	let subscription: Record<string, unknown> | null = null;
	let attachedSubs: { id: string; name: string; modality_name: string | null; product_name: string | null }[] = [];
	let attachedServerIds: string[] = [];
	if (view === 'servers' && sel) {
		[server] = await globalDb<Record<string, unknown>[]>`
			SELECT id::text AS id, name, ip_address, country, use_case, comment, activated,
			       delivery_method, root_path, use_partno_folder, container_path, auth
			FROM subscriber_server WHERE id = ${sel}`;
		if (server) {
			attachedSubs = await globalDb<typeof attachedSubs>`
				SELECT sub.id::text AS id, sub.name,
				       m.name AS modality_name, p.name AS product_name
				FROM subscription_server ss
				JOIN subscription sub ON sub.id = ss.subscription_id
				LEFT JOIN product m ON m.id = sub.modality_id
				LEFT JOIN product p ON p.id = sub.product_id
				WHERE ss.server_id = ${sel} ORDER BY sub.name`;
		}
	}
	if (view === 'subscriptions' && sel) {
		[subscription] = await globalDb<Record<string, unknown>[]>`
			SELECT sub.id::text AS id, sub.name, sub.pattern, sub.negate,
			       sub.modality_id::text AS modality_id, sub.product_id::text AS product_id,
			       m.name AS modality_name, p.name AS product_name, p.path::text AS product_display
			FROM subscription sub
			LEFT JOIN product m ON m.id = sub.modality_id
			LEFT JOIN product p ON p.id = sub.product_id
			WHERE sub.id = ${sel}`;
		if (subscription) {
			const rows = await globalDb<{ server_id: string }[]>`
				SELECT server_id::text AS server_id FROM subscription_server WHERE subscription_id = ${sel}`;
			attachedServerIds = rows.map((r) => r.server_id);
		}
	}

	return {
		isAdmin, view, sel, isNew, countries, modalities,
		servers, subscriptions, server, subscription, attachedSubs, attachedServerIds,
	};
};

function backTo(view: string, sel?: string | null): string {
	const u = new URLSearchParams({ view });
	if (sel) u.set('sel', sel);
	return `${base}/services/subscriptions?${u}`;
}

export const actions: Actions = {
	// -------------------------------------------------- Subscriber Servers ----
	saveServer: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		const name = orNull(d.get('name'));
		const delivery = orNull(d.get('delivery_method'));
		const useCase = orNull(d.get('use_case')) ?? 'internal';
		if (!name) return fail(400, { error: 'Name is required.' });
		if (!delivery || !['adls', 's3', 'scp'].includes(delivery))
			return fail(400, { error: 'A delivery method is required.' });

		const auth = buildAuth(delivery, d);
		const fields = {
			name,
			ip_address: orNull(d.get('ip_address')),
			country: orNull(d.get('country')),
			use_case: useCase,
			comment: orNull(d.get('comment')),
			activated: d.get('activated') === 'on',
			delivery_method: delivery,
			root_path: orNull(d.get('root_path')),
			use_partno_folder: d.get('use_partno_folder') === 'on',
			container_path: orNull(d.get('container_path')),
			auth: JSON.stringify(auth),
		};

		let newId = id;
		try {
			if (id) {
				await globalDb`
					UPDATE subscriber_server SET
						name = ${fields.name}, ip_address = ${fields.ip_address}, country = ${fields.country}, use_case = ${fields.use_case},
						comment = ${fields.comment}, activated = ${fields.activated},
						delivery_method = ${fields.delivery_method}, root_path = ${fields.root_path},
						use_partno_folder = ${fields.use_partno_folder}, container_path = ${fields.container_path},
						auth = ${fields.auth}::jsonb, updated_at = now()
					WHERE id = ${id}`;
			} else {
				[{ id: newId }] = await globalDb<{ id: string }[]>`
					INSERT INTO subscriber_server
						(name, ip_address, country, use_case, comment, activated, delivery_method,
						 root_path, use_partno_folder, container_path, auth)
					VALUES (${fields.name}, ${fields.ip_address}, ${fields.country}, ${fields.use_case}, ${fields.comment},
						${fields.activated}, ${fields.delivery_method}, ${fields.root_path},
						${fields.use_partno_folder}, ${fields.container_path}, ${fields.auth}::jsonb)
					RETURNING id::text AS id`;
			}
		} catch {
			return fail(400, { error: 'A subscriber server with that name already exists.' });
		}
		throw redirect(303, backTo('servers', newId));
	},

	deleteServer: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		if (!id) return fail(400, { error: 'Server required.' });
		await globalDb`DELETE FROM subscriber_server WHERE id = ${id}`;
		throw redirect(303, backTo('servers'));
	},

	// ------------------------------------------------------- Subscriptions ----
	saveSubscription: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		const name = orNull(d.get('name'));
		const pattern = orNull(d.get('pattern'));
		if (!name) return fail(400, { error: 'Name is required.' });
		if (!pattern) return fail(400, { error: 'A match pattern is required.' });

		const fields = {
			name, pattern,
			modality_id: orNull(d.get('modality_id')),
			product_id: orNull(d.get('product_id')),
			negate: d.get('negate') === 'on',
		};

		let newId = id;
		try {
			if (id) {
				await globalDb`
					UPDATE subscription SET
						name = ${fields.name}, pattern = ${fields.pattern},
						modality_id = ${fields.modality_id}, product_id = ${fields.product_id},
						negate = ${fields.negate}, updated_at = now()
					WHERE id = ${id}`;
			} else {
				[{ id: newId }] = await globalDb<{ id: string }[]>`
					INSERT INTO subscription (name, modality_id, product_id, pattern, negate)
					VALUES (${fields.name}, ${fields.modality_id}, ${fields.product_id},
						${fields.pattern}, ${fields.negate})
					RETURNING id::text AS id`;
			}
		} catch {
			return fail(400, { error: 'A subscription with that name already exists.' });
		}
		throw redirect(303, backTo('subscriptions', newId));
	},

	deleteSubscription: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const id = orNull(d.get('id'));
		if (!id) return fail(400, { error: 'Subscription required.' });
		await globalDb`DELETE FROM subscription WHERE id = ${id}`;
		throw redirect(303, backTo('subscriptions'));
	},

	// ----------------------------------------------------------- Attach -------
	// Rewrite the whole attachment set for one side (staged locally, saved together
	// like the Customers > Site membership editor). ids arrive as a JSON array.
	saveServerSubs: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const serverId = orNull(d.get('server_id'));
		if (!serverId) return fail(400, { error: 'Server required.' });
		let ids: string[];
		try { ids = JSON.parse(String(d.get('subscription_ids') ?? '[]')); } catch { return fail(400, { error: 'Bad data.' }); }
		ids = [...new Set(ids.filter((v) => typeof v === 'string' && v))];
		await globalDb.begin(async (sql) => {
			await sql`DELETE FROM subscription_server WHERE server_id = ${serverId}`;
			for (const subId of ids) {
				await sql`INSERT INTO subscription_server (subscription_id, server_id)
					VALUES (${subId}, ${serverId}) ON CONFLICT DO NOTHING`;
			}
		});
		throw redirect(303, backTo('servers', serverId));
	},

	saveSubServers: async ({ request, locals }) => {
		await requireAdmin(locals);
		const d = await request.formData();
		const subId = orNull(d.get('subscription_id'));
		if (!subId) return fail(400, { error: 'Subscription required.' });
		let ids: string[];
		try { ids = JSON.parse(String(d.get('server_ids') ?? '[]')); } catch { return fail(400, { error: 'Bad data.' }); }
		ids = [...new Set(ids.filter((v) => typeof v === 'string' && v))];
		await globalDb.begin(async (sql) => {
			await sql`DELETE FROM subscription_server WHERE subscription_id = ${subId}`;
			for (const serverId of ids) {
				await sql`INSERT INTO subscription_server (subscription_id, server_id)
					VALUES (${subId}, ${serverId}) ON CONFLICT DO NOTHING`;
			}
		});
		throw redirect(303, backTo('subscriptions', subId));
	},

	// Spool the resolved subscriptions to Valkey for aeroftp. NOT WIRED UP YET --
	// see docs/mdm_status.md open item "File Subscriptions -> Valkey spool".
	spoolValkey: async ({ locals }) => {
		await requireAdmin(locals);
		return { notice: 'Valkey spool is not wired up yet -- coming soon.' };
	},
};
