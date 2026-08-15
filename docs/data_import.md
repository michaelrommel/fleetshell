# Bulk data import + anonymization

Goal: load realistic volume (~190k devices, plus users/groups/grants/customers/
sites/gateways) into the dev clusters to validate the performance thesis
(indexed predicates, keyset pagination, no bitmaps) and to give the UI realistic
content. Source: CSV/JSON exports from the existing system.

## Golden rules

- **Never on prod.** Export -> transform in a staging dir -> `COPY` into dev.
- **Staging data is never committed.** `infrastructure/import/staging/` and the
  run maps are gitignored.
- **Referentially consistent during load, anonymous after.** A per-run map
  (`real_key -> new uuid`) stitches cross-file references (membership, grants,
  `created_by`, device->customer/site/gateway). After every dataset is loaded
  and references resolved, the maps are **destroyed** -> irreversible.

## Field transform rules

Keep (non-identifying, drive authz selectivity + realistic distributions):
`country, state, modality, product_path, software_version, gateway/region,
explicit_grant_only`, and all cardinalities (devices per country/modality/site).

Anonymize:

| Field(s) | Rule |
|---|---|
| user firstname/lastname | **Fully random** faker names (nothing derived from the real value) |
| user email | `user<seq>@example.test` |
| user_id (and all entity ids) | New UUID via a per-run map; map **discarded** after import |
| hospital_name | Fake via a same-run **LabelMap** (same real hospital -> same fake) so site grouping cardinality is preserved |
| customer name | Fake company via LabelMap |
| site name | Fake via LabelMap |
| serial / material number | Synthetic, format-preserving, unique |
| device free-text product name | **Not imported** (embeds person tokens); `product_path` already carries the category |
| group label | Kept if structural (e.g. `CCC_DE_military`); sanitize if it contains names |

Residual re-identification risk: rare attribute combinations can still single out
a device. Acceptable for a restricted dev environment; note for GDPR sign-off. If
compliance is strict, switch to fully synthetic rows matching the distributions.

## Pipeline

```
staging/*.csv|json                 # landed exports (gitignored)
   │  anonymize.py  (IdMap + LabelMap + fakers, per-run maps)
   ▼
copy/*.tsv                         # COPY-ready per target table
   │  load.py  (psycopg COPY)
   ▼
Aurora   global: device, gateway, customer, customer_site, product,
                 principal_group, authz_* ...
         local:  app_user, group_membership
   │  ANALYZE; benchmark.sql (EXPLAIN ANALYZE the country-admin list case)
   ▼
destroy run maps                   # irreversible
```

- **Split by plane**: users + membership -> local cluster; everything else ->
  global cluster.
- **Load with COPY** (not INSERT) for 190k rows; then `ANALYZE` each table.
- **Grants at scale**: import real groups/grants if available, else synthesize a
  representative set (e.g. ~100 country-admin groups) so list queries return
  realistically large sets.

## Validation after load

- `EXPLAIN (ANALYZE, BUFFERS)` on `authz_list_devices(...)` for a wide grant
  (a country admin whose scope covers ~100k devices), first page + a deep cursor.
- Confirm index usage on `device(country, modality, product_path, site_id, ...)`
  and that the plan is not a seq scan under the authz predicate.
- Time the check (`authz_can`) and the list page; record numbers to confirm the
  "plain Postgres, no bitmaps" decision holds at volume.

## Files (all implemented)

- `infrastructure/import/anonymize.py` - reusable core (IdMap, LabelMap, fakers).
- `infrastructure/import/load.py` - the importer: `--stage reference|devices|
  users|grants|all`, `--limit`, `--keep`. Reference tables (region ltree from
  RDREGION, product ltree, gateways) load idempotently; devices/users/grants
  anonymized and COPYed; id-maps destroyed after a full run. Uses a REAL CSV
  parser (quoted multi-line fields). Join keys verified 100% (device->region/
  product) / 99% (gateway).
- `infrastructure/import/seed_test_users.py` - curated broad->narrow test users.
- `infrastructure/import/benchmark.sql` / `diag_shapes.sql` - post-load
  validation + per-branch plan diagnostics.
- `infrastructure/import/old_database/` - the legacy CSV exports (gitignored).

Note: no continent layer is synthesized (RDCOUNTRY2DMZ/RDDMZ is a VPN routing
table, not geography); the region tree is World > Country > State from RDREGION.

## Known import gaps (verified against BU_AX; see chat 2026-xx)

The importer reads `RDGRANTVIEWV1`, a denormalized grant x grantee VIEW. Three
faithfully-diagnosed gaps, to fix in the importer (1-2) or in the production
export (3):

1. **Single-system (per-device) grants** -- **FIXED in load.py.** Rows whose
   "item" is a device serial in `FUNCTIONALLOCATION` (no region/product/
   customer/site) now become a `single_system` `authz_scope` + `authz_scope_device`
   row. `FUNCTIONALLOCATION` -> `RDSERVICEDSYSTEM.IDENTIFIER1` -> `device.id`
   resolves 100% (287 distinct devices; ~4,038 grantee-rows). Also folds in the
   few system-based service domains (e.g. Vestre Viken HF), which the export
   already decomposes into per-device rows. Takes effect on the NEXT FULL RELOAD
   (`--stage all`): the importer mints fresh scope/grant UUIDs each run, so a
   `--stage grants`-only re-run would duplicate, not patch.

2. **Named-customer / site grants -- NOT recoverable from this dump; deferred
   to the production load.** `CUSTOMERID=1`=ANY, `CUSTOMERID=0`=named customer
   whose id is lost (only `CUSTOMERNAME`); ~2,438 rows drop their customer and
   dedup into ANY siblings (~600 rows with a real numeric id import fine). The
   missing link is genuinely absent: there is NO RDCUSTOMER/RDSITE export;
   `RDSERVICEDSYSTEMBW1` has no customer/site columns (only hospital/router);
   `RDSERVICEDSYSTEM.CUSTOMERID` is empty for every device; and its
   `CUSTOMERSITEID` space does NOT overlap the grant view's `SITEID` (0 of 31
   match). Static/dynamic site membership (e.g. Marburg's 61, Uni Mainz's 58 via
   gateway) and the customer/site "requires explicit grant" flags live in tables
   that were not exported. Needs proper customer + site + site-membership exports
   in the production load. Interim risk: dropping the customer silently WIDENS a
   customer-restricted grant to ANY where the group has no wildcard sibling.

   **Update (Customers/Sites page):** because `RDSERVICEDSYSTEM.CUSTOMERID` is
   empty for 100% of device rows and there is no customer master export,
   `load.py` `site_uuid()` falls back to a SYNTHETIC customer per site
   (`"SC"+sid`), giving exactly one site per customer (4269 customers : 4269
   sites). So the portal shows no multi-site customers even though the legacy DB
   has them (e.g. `ABProjects` had several). The only real customer->site links
   in this dump are the ~7 domain-grant customers in `RDGRANTVIEWV1`
   (CUSTOMERID/CUSTOMERNAME/SITEID), where `ABProjects` (CUSTOMERID 12249133)
   shows just 2 sites -- a tiny subset, not the master. A full production export
   MUST include the customer master + customer<->site + site-membership tables;
   then drop the synthetic-customer fallback so real multi-site customers appear.
   (Site membership itself now materializes fine: `device.site_id` is seeded
   from the import and `resolve_site_membership()` + a `customer_id` backfill
   keep `device.customer_id` aligned to the site's customer -- see
   `migrate_customer_site.sql` and `reload.sh`.)

3. **Grants on member-less groups are invisible.** `RDGRANTVIEWV1` only
   materializes a row when a grant has a grantee (member). A group with grants
   but no members (e.g. `BU_AX_CS_SI_Sensis`, and its grants are inherited by
   sub-group members) produces zero rows, so neither the group nor its grants
   import. NOT fixable from this view. Production load MUST use a proper export
   of the group table + the group-grant table (not the grantee view).

Also note System Mgmt grants (roles like `System Mgmt Package Creator`) are a
separate subsystem not present in `RDGRANTVIEWV1` at all.
