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
// Caching (docs/authz_caching.md):
//   L0 - resolveGroupIds + scopeSignature are cached in Valkey (fail-open).
//   L1 - listDevices pages / counts are cached at the call sites (devices page,
//        deviceQuery) keyed by the scope-signature this module derives.

import { globalDb, localDb } from './db';
import { cacheGet, cacheSet, cacheDel, hashKey, authzGen, l0Ttl } from './cache';

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

/** Step 1 (REGIONAL): resolve a user to the group_ids they belong to (L0 cached). */
export async function resolveGroupIds(userId: string): Promise<string[]> {
	const key = `authz:groups:${userId}`;
	const hit = await cacheGet<string[]>(key);
	if (hit) return hit;
	const rows = await localDb<{ group_id: string }[]>`
		SELECT group_id FROM group_membership WHERE user_id = ${userId}
	`;
	const ids = rows.map((r) => r.group_id);
	await cacheSet(key, ids, await l0Ttl());
	return ids;
}

/** Invalidate a user's cached group_ids (call on group-membership change). */
export async function invalidateUserGroups(userId: string): Promise<void> {
	await cacheDel(`authz:groups:${userId}`);
}

/**
 * L0 scope-signature: a stable digest of the effective scope-id SET a group set
 * resolves to for (resourceType, verb). Many users share the exact same set, so
 * the signature is the natural key for the L1 result-page cache -- 300 users in
 * one group collapse to one signature (docs/authz_caching.md section 4). The
 * signature is itself cached, keyed by the sorted groupIds hash + the global
 * authz generation (so a grant/role/scope edit rotates it via bumpAuthzGen()).
 */
export async function scopeSignature(
	groupIds: string[],
	verb: string,
	resourceType = 'device',
): Promise<string> {
	if (groupIds.length === 0) return 'none';
	const g = await authzGen();
	const gh = hashKey(...[...groupIds].sort());
	const key = `authz:sig:${g}:${resourceType}:${verb}:${gh}`;
	const hit = await cacheGet<string>(key);
	if (hit) return hit;
	const rows = await globalDb<{ scope_id: string }[]>`
		SELECT scope_id::text AS scope_id
		FROM authz_effective_scopes(${groupIds}::uuid[], ${resourceType}, ${verb})
		ORDER BY scope_id
	`;
	const sig = hashKey('sig', ...rows.map((r) => r.scope_id));
	await cacheSet(key, sig, await l0Ttl());
	return sig;
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
 * Feature-entitlement check for a portal service FUNCTION, identified by its
 * stable catalog key (e.g. 'screen_recording'). Orthogonal to the device scope:
 * a gated function ANDs this with `can(..., 'view', deviceId)`. See
 * infrastructure/sql/migrate_services_authz.sql (authz_can_service).
 */
export async function canService(
	groupIds: string[],
	verb: string,
	serviceKey: string,
): Promise<boolean> {
	if (groupIds.length === 0) return false;
	const [row] = await globalDb<{ ok: boolean }[]>`
		SELECT authz_can_service_key(${groupIds}::uuid[], ${verb}, ${serviceKey}) AS ok
	`;
	return row?.ok ?? false;
}

/** Coarse capability check: does the persona hold ANY grant of (type, verb)? */
export async function authzHas(
	groupIds: string[],
	resourceType: string,
	verb: string,
): Promise<boolean> {
	if (groupIds.length === 0) return false;
	const [row] = await globalDb<{ ok: boolean }[]>`
		SELECT authz_has(${groupIds}::uuid[], ${resourceType}, ${verb}) AS ok
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
