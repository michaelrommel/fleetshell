// src/lib/server/personaSearch.ts
//
// Single source of truth for the persona type-ahead / list search predicate,
// shared by BOTH persona search paths so they can never drift:
//   * the Admin > Personas list `load` (keyset-paginated browse), and
//   * GET /api/administration/personas (lightweight picker for Groups "Add a
//     member" + Accounts linking).
//
// Tokenized on whitespace: EVERY token must match SOME field (AND of tokens, OR
// across fields), so "Michael Rommel" matches firstname='Michael' AND
// lastname='Rommel' regardless of word order; a single token still works.

import type { Sql } from 'postgres';

/**
 * Build a WHERE-fragment that AND-chains one predicate per query token, each
 * OR-matching firstname / lastname / user_id / role_label. The `app_user` table
 * MUST be aliased `u`. Returns an EMPTY fragment when the query is blank, so
 * callers splice it after a `WHERE true ` (or another `AND ...`) unconditionally:
 *
 *   const search = personaSearchFilter(localDb, q);
 *   await localDb`SELECT ... FROM app_user u WHERE true ${search} ${cursor} ...`;
 */
export function personaSearchFilter(sql: Sql, q: string) {
	const tokens = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
	let frag = sql``;
	for (const t of tokens) {
		const like = '%' + t + '%';
		frag = sql`${frag} AND (u.firstname ILIKE ${like} OR u.lastname ILIKE ${like}
		           OR u.user_id ILIKE ${like} OR u.role_label ILIKE ${like})`;
	}
	return frag;
}
