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
