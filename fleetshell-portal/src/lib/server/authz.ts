// src/lib/server/authz.ts
//
// The two-step authorization bridge (see docs/mdm_design.md):
//   1. resolveGroupIds(userId)  -- REGIONAL: user -> group_ids (local plane)
//   2. listDevices / can        -- GLOBAL: group_ids -> devices (authz plane)
//
// The global functions apply grant inheritance (ancestor groups) and the
// explicit_grant_only rule; see infrastructure/sql/authz_resolve.sql. The NULL
// and exclusion invariants in mdm_design.md section 5.1 live inside those SQL
// functions, so this layer stays thin.
//
// TODO (docs/authz_caching.md):
//   L0 - cache resolveGroupIds + derived scope-signature in Valkey (5-15 min).
//   L1 - cache listDevices pages keyed by scope-signature (30-60 s).

import { globalDb, localDb } from './db';

export type Device = {
	id: string;
	region_path: string | null;
	country_iso: string | null;
	modality: string | null;
	product_path: string | null;
	customer_id: string | null;
	site_id: string | null;
	gateway_id: string | null;
	hospital_name: string | null;
	software_version: string | null;
	access_requirement: 'open' | 'device' | 'customer' | 'site';
	updated_at: string;
};

export type Cursor = { updatedAt: string; id: string };

/** Step 1 (REGIONAL): resolve a user to the group_ids they belong to. */
export async function resolveGroupIds(userId: string): Promise<string[]> {
	const rows = await localDb<{ group_id: string }[]>`
		SELECT group_id FROM group_membership WHERE user_id = ${userId}
	`;
	return rows.map((r) => r.group_id);
}

/** Step 2 (GLOBAL): keyset-paginated list of devices the groups may `verb`. */
export async function listDevices(
	groupIds: string[],
	verb: string,
	cursor?: Cursor,
	limit = 50,
): Promise<Device[]> {
	if (groupIds.length === 0) return [];
	const afterUpdated = cursor?.updatedAt ?? null;
	const afterId = cursor?.id ?? null;

	return await globalDb<Device[]>`
		SELECT id, region_path::text AS region_path, country_iso, modality,
		       product_path::text AS product_path, customer_id, site_id, gateway_id,
		       hospital_name, software_version, access_requirement, updated_at
		FROM authz_list_devices(
			${groupIds}::uuid[], ${verb}, ${afterUpdated}, ${afterId}, ${limit}
		)
	`;
}

/** Step 2 (GLOBAL): point check for a single device. */
export async function can(
	groupIds: string[],
	verb: string,
	deviceId: string,
): Promise<boolean> {
	if (groupIds.length === 0) return false;
	const [row] = await globalDb<{ ok: boolean }[]>`
		SELECT authz_can(${groupIds}::uuid[], ${verb}, ${deviceId}) AS ok
	`;
	return row?.ok ?? false;
}

/**
 * Enumerate the device ids a set of groups may `verb`, capped. Used by the
 * Devices page 'My scope' mode to constrain a searchable/paginated query to the
 * authorized set. For very broad scopes (whole fleet) admins use 'All devices'
 * mode instead, so the cap is a safety bound, not a correctness limit.
 */
export async function authorizedDeviceIds(
	groupIds: string[],
	verb: string,
	cap = 20000,
): Promise<string[]> {
	if (groupIds.length === 0) return [];
	const rows = await globalDb<{ id: string }[]>`
		SELECT id::text AS id
		FROM authz_list_devices(${groupIds}::uuid[], ${verb}, ${null}, ${null}, ${cap})
	`;
	return rows.map((r) => r.id);
}
