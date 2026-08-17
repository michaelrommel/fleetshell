// src/lib/server/cache.ts
//
// Fail-open Valkey caching primitives for the authorization fast path
// (docs/authz_caching.md). Every helper swallows Valkey errors and behaves as a
// cache MISS: a broken/absent Valkey never breaks a request, it only removes the
// speed-up. Reuses the singleton client from redis.ts.
//
// Layers built on top of this (see authz.ts / deviceQuery.ts / devices page):
//   L0  authz:groups:{userId}          user -> group_ids           TTL 600s
//   L0  authz:sig:{g}:{type}:{verb}:{gh} groups -> scope-signature  TTL 600s
//   L1  list:dev:{g}:{sig}:{fh}:{cur}  rendered page               TTL 45s
//   L1  count:dev:{g}:{sig}:{fh}       exact/approx total          TTL 45s
//
// Invalidation model:
//   - Group membership change -> invalidate that user's authz:groups key only.
//     (The groupIds hash then changes, so the signature + page keys rotate on
//      their own; no global flush needed.)
//   - Grant / role-privilege / scope change -> bumpAuthzGen() (INCR authz:gen).
//     The generation `g` is embedded in every signature + page + count key, so a
//     single INCR logically invalidates all of them at once; the stale keys age
//     out by TTL.
//   - Device attribute changes ride the short L1 TTL (30-60s tolerable staleness).

import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getRedisClient } from './redis';

/** Hard kill switch (env). When AUTHZ_CACHE=false nothing caches, regardless
 * of the runtime config below. */
export function cacheKillSwitch(): boolean {
	return env.AUTHZ_CACHE === 'false';
}

// --- Runtime config (Valkey hash authz:cfg), tunable from the Settings page ---

export type CacheConfig = { enabled: boolean; l0Ttl: number; l1Ttl: number };
export const CACHE_DEFAULTS: CacheConfig = { enabled: true, l0Ttl: 600, l1Ttl: 45 };
const CFG_KEY = 'authz:cfg';
const CFG_SOFT_MS = 5000; // in-process reuse window (avoid a HGETALL per call)
let cfgCache: { v: CacheConfig; at: number } | undefined;

/** Resolved cache config; falls back to defaults when Valkey is unreachable. */
export async function getCacheConfig(): Promise<CacheConfig> {
	const now = Date.now();
	if (cfgCache && now - cfgCache.at < CFG_SOFT_MS) return cfgCache.v;
	let v: CacheConfig = { ...CACHE_DEFAULTS };
	try {
		const c = await getRedisClient();
		const h = await c.hGetAll(CFG_KEY);
		if (h.enabled != null) v.enabled = h.enabled !== '0';
		if (h.l0_ttl) v.l0Ttl = Math.max(5, Number(h.l0_ttl) || CACHE_DEFAULTS.l0Ttl);
		if (h.l1_ttl) v.l1Ttl = Math.max(5, Number(h.l1_ttl) || CACHE_DEFAULTS.l1Ttl);
	} catch (e) {
		warn('cfg', e);
	}
	cfgCache = { v, at: now };
	return v;
}

/** Persist cache config (partial) to Valkey and reset the in-process memo. */
export async function setCacheConfig(patch: Partial<CacheConfig>): Promise<void> {
	cfgCache = undefined;
	try {
		const c = await getRedisClient();
		const fields: Record<string, string> = {};
		if (patch.enabled !== undefined) fields.enabled = patch.enabled ? '1' : '0';
		if (patch.l0Ttl !== undefined) fields.l0_ttl = String(Math.max(5, Math.floor(patch.l0Ttl)));
		if (patch.l1Ttl !== undefined) fields.l1_ttl = String(Math.max(5, Math.floor(patch.l1Ttl)));
		if (Object.keys(fields).length) await c.hSet(CFG_KEY, fields);
	} catch (e) {
		warn('setCfg', e);
	}
}

/** True when caching is effectively on (kill switch off AND runtime enabled). */
async function isEnabled(): Promise<boolean> {
	if (cacheKillSwitch()) return false;
	return (await getCacheConfig()).enabled;
}

/** L0 (groups + signature) TTL, from runtime config. */
export async function l0Ttl(): Promise<number> {
	return (await getCacheConfig()).l0Ttl;
}

/** L1 (pages + counts) TTL, from runtime config. */
export async function l1Ttl(): Promise<number> {
	return (await getCacheConfig()).l1Ttl;
}

/** Short, stable, filename-safe digest of the given parts (NUL-joined). */
export function hashKey(...parts: (string | number | null | undefined)[]): string {
	const h = createHash('sha1');
	h.update(parts.map((p) => String(p ?? '')).join('\u0000'));
	return h.digest('base64url').slice(0, 22);
}

function warn(op: string, e: unknown): void {
	console.warn(`[cache] ${op} failed (fail-open):`, e instanceof Error ? e.message : e);
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
	if (!(await isEnabled())) return undefined;
	try {
		const c = await getRedisClient();
		const raw = await c.get(key);
		return raw == null ? undefined : (JSON.parse(raw) as T);
	} catch (e) {
		warn('get', e);
		return undefined;
	}
}

export async function cacheSet(key: string, val: unknown, ttlSec: number): Promise<void> {
	if (!(await isEnabled())) return;
	try {
		const c = await getRedisClient();
		await c.set(key, JSON.stringify(val), { EX: ttlSec });
	} catch (e) {
		warn('set', e);
	}
}

export async function cacheDel(keys: string | string[]): Promise<void> {
	try {
		const c = await getRedisClient();
		await c.del(keys as string & string[]);
	} catch (e) {
		warn('del', e);
	}
}

// --- Global authorization generation (bulk invalidation) ---------------------

const GEN_KEY = 'authz:gen';
let genCache: { v: number; at: number } | undefined;
const GEN_SOFT_MS = 5000; // in-process reuse window to avoid a GET per request

/** Current authz generation; 0 when caching is disabled or Valkey is down. */
export async function authzGen(): Promise<number> {
	if (!(await isEnabled())) return 0;
	const now = Date.now();
	if (genCache && now - genCache.at < GEN_SOFT_MS) return genCache.v;
	try {
		const c = await getRedisClient();
		let v = await c.get(GEN_KEY);
		if (v == null) {
			await c.set(GEN_KEY, '1');
			v = '1';
		}
		const n = Number(v) || 1;
		genCache = { v: n, at: now };
		return n;
	} catch (e) {
		warn('gen', e);
		return 0;
	}
}

/** Bump the generation: logically flushes all signature/page/count caches. */
export async function bumpAuthzGen(): Promise<void> {
	genCache = undefined;
	try {
		const c = await getRedisClient();
		await c.incr(GEN_KEY);
	} catch (e) {
		warn('bumpGen', e);
	}
}
