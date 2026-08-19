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
	c:    ['country_iso'],
	city: ['city'],
	hosp: ['hospital_name'],
};
const BARE_COLS = ['serial', 'functional_location', 'ip_address', 'ip_real'];

// Substring match (default) OR case-insensitive exact match (quoted term).
function matchFrag(cols: string[], val: string, exact: boolean) {
	let e = globalDb`FALSE`;
	for (const c of cols) {
		e = exact
			? globalDb`${e} OR lower(d.${globalDb(c)}) = lower(${val})`
			: globalDb`${e} OR d.${globalDb(c)} ILIKE ${'%' + val + '%'}`;
	}
	return globalDb`(${e})`;
}

// Split honoring double-quoted spans (which may contain spaces + a leading
// qualifier, e.g. `sn:"exact value"` or `"exact value"`). A quoted VALUE means
// exact match; everything else stays a substring search.
function splitTokens(query: string): string[] {
	return query.match(/(?:[a-zA-Z]+:)?"[^"]*"|\S+/g) ?? [];
}
function unquote(s: string): { value: string; exact: boolean } {
	return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
		? { value: s.slice(1, -1), exact: true }
		: { value: s, exact: false };
}

/** Parse the query into a SQL WHERE fragment (aliased `d`). Empty -> TRUE. */
export function buildDeviceWhere(query: string) {
	const tokens = splitTokens(query.trim());
	const frags = tokens.map((t) => {
		const m = t.match(/^([a-zA-Z]+):([\s\S]*)$/);
		const cols = m && QUALIFIERS[m[1].toLowerCase()];
		if (cols) { const u = unquote(m![2]); return matchFrag(cols, u.value, u.exact); }
		const u = unquote(t);
		return matchFrag(BARE_COLS, u.value, u.exact);
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
