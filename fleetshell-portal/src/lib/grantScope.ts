// Shared grant-scope decoding: one SQL fragment + one row shape, used by every
// page that lists authz grants (Grants, Groups, Personas). Centralising this
// keeps the decoder and the display in lock-step so EVERY resource_type renders
// as its own kind -- device / gateway / group / service / product / customer /
// site -- instead of silently falling back to the device triple.
//
// This module lives in $lib (NOT $lib/server) on purpose: it holds no DB handle,
// only the row TYPE (imported by the GrantScope.svelte component) and a pure SQL
// fragment builder that takes the caller's `sql` instance. That keeps the
// server/client import boundary clean.

import type { Sql } from 'postgres';

/** Decoded scope columns shared by all grant-list queries. */
export type GrantScope = {
	resource_type: string;
	scope_kind: string;
	region: string;
	product: string;
	customer: string;
	site: string;
	group_scope: string;
	service_scope: string;
	single_label: string;
};

/**
 * SELECT-list fragment that decodes an `authz_scope s` (aliased `s`) into the
 * `GrantScope` columns. Splice it after your own columns, e.g.:
 *
 *   SELECT g.id::text AS grant_id, r.name AS role_name, ${grantScopeColumns(sql)}
 *   FROM authz_grant g JOIN authz_role r ON ... JOIN authz_scope s ON ...
 *
 * The subqueries reference the outer `s`, so the query MUST alias authz_scope
 * as `s`.
 */
export function grantScopeColumns(sql: Sql) {
	return sql`
		s.resource_type, s.kind AS scope_kind,
		COALESCE((SELECT string_agg(reg.name, ', ') FROM authz_scope_constraint c
		          JOIN region reg ON reg.path = ANY(c.values::ltree[])
		          WHERE c.scope_id = s.id AND c.dimension = 'region_path'), 'ANY') AS region,
		COALESCE((SELECT string_agg(
		            COALESCE((SELECT tp.name FROM product tp WHERE tp.path = subltree(p.path, 0, LEAST(nlevel(p.path), 2))), p.name)
		              || ' / ' || CASE WHEN nlevel(p.path) <= 2 THEN 'ANY' ELSE p.name END, ', ')
		          FROM authz_scope_constraint c
		          JOIN product p ON p.path = ANY(c.values::ltree[])
		          WHERE c.scope_id = s.id AND c.dimension = 'product_path'), 'ANY') AS product,
		COALESCE((SELECT string_agg(cu.name, ', ') FROM authz_scope_constraint c
		          JOIN customer cu ON cu.id = ANY(c.values::uuid[])
		          WHERE c.scope_id = s.id AND c.dimension = 'customer_id'), 'ANY') AS customer,
		COALESCE((SELECT string_agg(si.name, ', ') FROM authz_scope_constraint c
		          JOIN customer_site si ON si.id = ANY(c.values::uuid[])
		          WHERE c.scope_id = s.id AND c.dimension = 'site_id'), 'ANY') AS site,
		COALESCE((SELECT string_agg(gp.label, ', ') FROM authz_scope_constraint c
		          JOIN principal_group gp ON gp.path = ANY(c.values::ltree[])
		          WHERE c.scope_id = s.id AND c.dimension = 'group_path'), 'ANY') AS group_scope,
		COALESCE((SELECT string_agg(sv.name, ', ') FROM authz_scope_constraint c
		          JOIN service sv ON sv.path = ANY(c.values::ltree[])
		          WHERE c.scope_id = s.id AND c.dimension = 'service_path'), 'ANY') AS service_scope,
		COALESCE(s.label, '') AS single_label
	`;
}
