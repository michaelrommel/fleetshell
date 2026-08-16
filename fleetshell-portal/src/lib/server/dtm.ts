// src/lib/server/dtm.ts
//
// Data Transfer Matrix: helpers to load/save a FROM-country x variant matrix
// and to spool it into Valkey. See docs/data_transfer_matrix.md.
//
// Storage model: DENIAL-LIST, default = permit. dtm_deny holds only the denied
// (from, to, variant, class) tuples; absence => permitted.
//
// Valkey key (hash-tagged so a whole origin country co-locates in one cluster
// slot, enabling an ATOMIC per-country swap + multi-key ops on MemoryDB):
//
//   SET dtm:{<FROM>}:<TO>:<VARIANT>   members = denied data-class codes
//
// aerosuite reads it single-key: SISMEMBER dtm:{<from>}:<to>:<variant> <class>.

import { createClient } from 'redis';
import { env } from '$env/dynamic/private';
import { globalDb } from './db';

/** Valkey key for one cell set; {from} is the co-location hash tag. */
export const dtmKey = (from: string, to: string, variant: string) => `dtm:{${from}}:${to}:${variant}`;

export type DataClass = { code: string; label: string; kind: string; sort_order: number };
export type Country = { iso: string; name: string };

/** The data-class catalog (shared with the classification feature). */
export async function listClasses(): Promise<DataClass[]> {
	return globalDb<DataClass[]>`
		SELECT code, label, kind, sort_order FROM data_class ORDER BY sort_order, code`;
}

/** Variants (Standard/Strict/...); Standard is the runtime default. */
export async function listVariants(): Promise<{ code: string; label: string }[]> {
	return globalDb<{ code: string; label: string }[]>`
		SELECT code, label FROM dtm_variant ORDER BY sort_order, code`;
}

/** Distinct ISO countries (region level-2), unioned with any DTM destination. */
export async function listCountries(): Promise<Country[]> {
	const rows = await globalDb<Country[]>`
		SELECT iso, name FROM (
			SELECT DISTINCT ON (iso) iso, name
			FROM region WHERE nlevel(path) = 2 AND iso IS NOT NULL
			ORDER BY iso, name
		) c
		UNION
		SELECT d.to_iso AS iso, d.to_iso AS name
		FROM dtm_deny d
		WHERE d.to_iso NOT IN (SELECT iso FROM region WHERE nlevel(path) = 2 AND iso IS NOT NULL)
		ORDER BY name`;
	return rows;
}

/** All denials for one FROM x variant: to_iso -> denied class codes. */
export async function loadMatrix(fromIso: string, variant: string): Promise<{
	defined: boolean;
	deny: Record<string, string[]>;
}> {
	const [hdr] = await globalDb<{ n: number }[]>`
		SELECT count(*)::int AS n FROM dtm_matrix WHERE from_iso = ${fromIso} AND variant = ${variant}`;
	const rows = await globalDb<{ to_iso: string; class_code: string }[]>`
		SELECT to_iso, class_code FROM dtm_deny WHERE from_iso = ${fromIso} AND variant = ${variant}`;
	const deny: Record<string, string[]> = {};
	for (const r of rows) (deny[r.to_iso] ??= []).push(r.class_code);
	return { defined: hdr.n > 0, deny };
}

/**
 * Replace a FROM x variant matrix from the editor. `deny` maps to_iso -> codes;
 * only denied tuples are stored. Writing an EMPTY map still marks the matrix as
 * DEFINED (header row) so the runtime distinguishes "defined, all permitted"
 * from "no matrix" (both permit, but the distinction is kept for clarity).
 */
export async function saveMatrix(
	fromIso: string,
	variant: string,
	deny: Record<string, string[]>,
	updatedBy: string | null,
): Promise<{ cells: number }> {
	let cells = 0;
	await globalDb.begin(async (sql) => {
		await sql`
			INSERT INTO dtm_matrix (from_iso, variant, updated_by, updated_at)
			VALUES (${fromIso}, ${variant}, ${updatedBy}, now())
			ON CONFLICT (from_iso, variant) DO UPDATE SET updated_by = ${updatedBy}, updated_at = now()`;
		await sql`DELETE FROM dtm_deny WHERE from_iso = ${fromIso} AND variant = ${variant}`;
		for (const [to, codes] of Object.entries(deny)) {
			for (const code of new Set(codes)) {
				await sql`
					INSERT INTO dtm_deny (from_iso, to_iso, variant, class_code)
					VALUES (${fromIso}, ${to}, ${variant}, ${code})`;
				cells++;
			}
		}
	});
	return { cells };
}

// --- Valkey ------------------------------------------------------------------

let _client: ReturnType<typeof createClient> | undefined;
async function valkey() {
	if (_client?.isReady) return _client;
	const url = env.VALKEY_URL ?? 'rediss://localhost:6380';
	const rejectUnauthorized = env.VALKEY_TLS_REJECT_UNAUTHORIZED !== 'false';
	_client = createClient({
		url,
		socket: url.startsWith('rediss://') ? { tls: true, rejectUnauthorized } : undefined,
	});
	_client.on('error', (err: Error) => console.error('[valkey] dtm client error:', err.message));
	await _client.connect();
	return _client;
}

/**
 * Spool ONE origin country into Valkey with an ATOMIC swap. Every dtm:{from}:*
 * key shares a slot (hash tag), so we UNLINK the country's existing keys and
 * SADD the fresh ones inside a single MULTI/EXEC -- no CROSSSLOT, no gap.
 * Returns the number of keys written and stale keys removed.
 */
export async function syncFromCountryToValkey(fromIso: string): Promise<{ written: number; removed: number }> {
	const rows = await globalDb<{ to_iso: string; variant: string; codes: string[] }[]>`
		SELECT to_iso, variant, array_agg(class_code ORDER BY class_code) AS codes
		FROM dtm_deny WHERE from_iso = ${fromIso}
		GROUP BY to_iso, variant`;

	const client = await valkey();
	const existing: string[] = [];
	for await (const batch of client.scanIterator({ MATCH: `dtm:{${fromIso}}:*`, COUNT: 1000 })) {
		for (const k of Array.isArray(batch) ? batch : [batch]) existing.push(k);
	}

	const multi = client.multi();
	if (existing.length) multi.unlink(existing);          // multi-key, co-slot
	for (const r of rows) multi.sAdd(dtmKey(fromIso, r.to_iso, r.variant), r.codes);
	await multi.exec();

	return { written: rows.length, removed: existing.length };
}
