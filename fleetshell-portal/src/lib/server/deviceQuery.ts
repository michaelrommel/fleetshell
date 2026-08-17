// src/lib/server/deviceQuery.ts
//
// Shared device search + scope helpers for the Devices page and its count
// endpoint. The Google-style parser and the scope/all count live here so the
// page load (list) and /devices/count (total) stay in lockstep.

import { globalDb } from './db';
import { resolveGroupIds, scopeSignature } from './authz';
import { cacheGet, cacheSet, hashKey, authzGen, l1Ttl } from './cache';

export type CountResult = { total: number; ms: number; cached: boolean };

// Bare terms hit the most-used fields; `qualifier:value` restricts to one; ANDed.
export const QUALIFIERS: Record<string, string[]> = {
	sn:   ['serial'],
	fl:   ['functional_location'],
	ip:   ['ip_address', 'ip_real'],
	tid:  ['technical_ident'],
	host: ['host_hw_id'],
	ord:  ['order_number'],
};
const BARE_COLS = ['serial', 'functional_location', 'ip_address', 'ip_real'];

function likeFrag(cols: string[], val: string) {
	let e = globalDb`FALSE`;
	for (const c of cols) e = globalDb`${e} OR d.${globalDb(c)} ILIKE ${val}`;
	return globalDb`(${e})`;
}

/** Parse the query into a SQL WHERE fragment (aliased `d`). Empty -> TRUE. */
export function buildDeviceWhere(query: string) {
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

/**
 * Exact count of devices matching (mode, q). Expensive for broad scopes
 * (~800ms; materializes the visible-id set), so callers compute it only when
 * the filter changes -- the page threads the result through pagination links.
 */
export async function countDevices(userId: string, mode: 'scope' | 'all', q: string): Promise<CountResult> {
	const where = buildDeviceWhere(q);
	const t0 = performance.now();
	if (mode === 'all') {
		const g = await authzGen();
		const key = `count:dev:${g}:all:${hashKey(q)}`;
		const hit = await cacheGet<number>(key);
		if (hit !== undefined) return { total: hit, ms: Math.round(performance.now() - t0), cached: true };
		const [{ total }] = await globalDb<{ total: number }[]>`
			SELECT count(*)::int AS total FROM device d WHERE ${where}`;
		await cacheSet(key, total, await l1Ttl());
		return { total, ms: Math.round(performance.now() - t0), cached: false };
	}
	const groupIds = await resolveGroupIds(userId);
	if (!groupIds.length) return { total: 0, ms: Math.round(performance.now() - t0), cached: false };
	const sig = await scopeSignature(groupIds, 'view');
	const g = await authzGen();
	const key = `count:dev:${g}:${sig}:${hashKey(q)}`;
	const hit = await cacheGet<number>(key);
	if (hit !== undefined) return { total: hit, ms: Math.round(performance.now() - t0), cached: true };
	const [{ total }] = await globalDb<{ total: number }[]>`
		SELECT count(*)::int AS total
		FROM device d JOIN authz_visible_device_ids(${groupIds}::uuid[], 'view') v ON v.id = d.id
		WHERE ${where}`;
	await cacheSet(key, total, await l1Ttl());
	return { total, ms: Math.round(performance.now() - t0), cached: false };
}
