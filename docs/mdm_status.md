# MDM Rebuild — START HERE (agent handoff)

This is the entry point for the Master Data Management + authorization rebuild.
Read this first, then `docs/mdm_design.md` (architecture), `docs/authz_caching.md`
(performance), and `docs/data_import.md` (bulk import).

## What this is

Replacing the Valkey key/value store as the system of record for
device/gateway/customer relations and authorization. A brand-new SvelteKit
portal (`fleetshell-portal-dev/`, served under `/dev/`) reads from Aurora
PostgreSQL instead of Valkey. The legacy portal (`fleetshell-portal/`) is
untouched and still serves `/`.

## Status: DONE

- **Two Aurora PostgreSQL clusters live** (eu-west-2, Serverless v2):
  - GLOBAL (Aurora Global Database, `fleetshell-global-euw2`, db `fleetshell`) —
    master data + authorization. Encrypted, has a reader instance + RDS Proxy.
  - LOCAL (standalone, `fleetshell-local-euw2`, db `fleetshell_local`) — user PII
    + group membership.
  - Built by `infrastructure/make_aurora_global.sh` / `make_aurora_local.sh`
    (run manually; RESULTs captured in-file). Bastion access via `aerocli`
    (STEP 10) on 5432.
- **Schema applied + validated** (`infrastructure/sql/`):
  - `schema_global.sql`, `schema_local.sql`, `authz_resolve.sql` (reference),
    `authz_fastpath.sql` (index-using production `authz_list_devices`/`authz_can`),
    plus migrations `migrate_region_access.sql` (region ltree + graded
    access_requirement) and `migrate_theme_*.sql`.
  - `seed_demo.sql` + `verify_demo.sql` — the model's correctness proof
    (inheritance, explicit-access, region subtree). All green.
- **Real data imported + anonymized** (`infrastructure/import/`):
  - `load.py` ingested the legacy CSV exports (`old_database/`): **192k devices,
    ~1M grant rows, 7.7k users, 20k gateways, 467 regions, 392 products**. Names
    and identifiers anonymized; id-maps destroyed after (irreversible).
  - `seed_test_users.py` — 6 curated test users (broad→narrow) for the dev login.
- **Performance validated at real volume** (see `docs/authz_caching.md` §11):
  list page-1 ~330–390 ms for the broadest users (whole fleet / 41k devices),
  <50 ms expected for narrow users, point check 25 ms. Down from 173 s.
- **Portal dev slice working** (`fleetshell-portal-dev/`): password login for a
  `login_account` (the human) that assumes one of its linked `app_user` personas
  via a post-login **Persona Selector** (switchable from the top bar); Nucleus
  AppShell (top bar + icon rail); authorized device list; **full Administration**
  (Accounts, Personas, Roles = editable privilege matrix, Groups = expandable
  tree, Grants v1 = group-centric scope builder), admin-gated; two selectable
  themes (Nucleus default / Gruvbox), base-path-aware WebSocket server,
  postgres.js to both
  planes.

## How to run it (local dev)

```bash
# 1. Two SSM/SSH tunnels through the aerocli bastion (i-01a9bfe89868566ea):
ssh -L 5432:$GLOBAL_WRITER_ENDPOINT:5432 aerocli    # global
ssh -L 5433:$LOCAL_WRITER_ENDPOINT:5432  aerocli    # local

# 2. Identity model migration + seed (once, against the local plane):
psql "$LOCAL_WRITER_URL" -f infrastructure/sql/migrate_identity_local.sql
psql "$LOCAL_WRITER_URL" -f infrastructure/sql/migrate_identity_primary.sql
psql "$LOCAL_WRITER_URL" -f infrastructure/sql/migrate_persona_rename.sql
psql "$GLOBAL_WRITER_URL" -f infrastructure/sql/migrate_authz_catalog.sql
node infrastructure/import/seed_login_accounts.mjs | psql "$LOCAL_WRITER_URL"

# 3. Portal
cp .env.example .env            # fill GLOBAL_/LOCAL_DB_PASSWORD, SESSION_SECRET
npm install && npm run dev      # http://localhost:5173/dev/login
# login super/super123 (all personas, incl. SuperUser=admin) or nora/nora123
```

Global DB password = the self-set `MASTER_PW` (Aurora Global can't use managed
secrets). Local DB password = from Secrets Manager (managed). See
`make_aurora_global.sh` STEP 5-SECRET.

## Re-running the data pipeline / full reload

The importer mints fresh scope/grant UUIDs each run, so it is TRUNCATE-and-reload
(a `--stage grants`-only re-run would duplicate). The schema is already the final
shape in the live DBs, so a reload does NOT re-run the identity migrations -- only
the post-load steps (catalog normalize + group hierarchy). **One exception**:
`migrate_product_model.sql` (product/model split) must run **before** `load.py`,
because the new importer writes the `product.kind/family` columns and the
`product_model` table it creates. It is idempotent, so running it first is safe.

```bash
export IMPORT_GLOBAL_DSN="host=localhost port=5432 dbname=fleetshell       user=fsadmin password=... sslmode=require"
export IMPORT_LOCAL_DSN="host=localhost port=5433 dbname=fleetshell_local user=fsadmin password=... sslmode=require"
export GLOBAL_WRITER_URL="postgresql://fsadmin:...@localhost:5432/fleetshell?sslmode=require"
export LOCAL_WRITER_URL="postgresql://fsadmin:...@localhost:5433/fleetshell_local?sslmode=require"
cd infrastructure

# 0. Product/model schema (idempotent; MUST precede load.py so the new columns +
#    product_model / product_model_app tables exist before the importer writes them).
psql "$GLOBAL_WRITER_URL" -f sql/migrate_product_model.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_identity.sql   # device serial/FL/IP/tid/host/ord/contact/city + trigram indexes
psql "$GLOBAL_WRITER_URL" -f sql/migrate_gateway_enrich.sql    # gateway (RS router) name/city/router_type/admin_ip/... + trigram indexes
psql "$GLOBAL_WRITER_URL" -f sql/migrate_gateway_ipsec.sql     # gateway public_ip/psk/ipsec (IPsec tunnel config; UI-authored, not imported)
psql "$GLOBAL_WRITER_URL" -f sql/migrate_gateway_hostname.sql  # dns_name -> nullable hostname (dynamic-IP DynDNS); clears synthetic fleetshell names

# 1. Reset the loaded/derived data (keeps schema + authz_privilege canonical seed).
#    product CASCADE also clears product_model + product_model_app via their FK.
psql "$GLOBAL_WRITER_URL" -c "TRUNCATE region, product, gateway, device, customer, customer_site, principal_group, authz_role, authz_scope, authz_grant CASCADE;"
psql "$LOCAL_WRITER_URL"  -c "TRUNCATE app_user, login_account CASCADE;"

# 2. Re-import from the legacy CSVs (fresh id maps; maps destroyed at the end).
cd import && rm -f *.map.json
python load.py --stage all                # single-system grants + product models (RDPRODUCTMODEL: ~1386 models) + device identity fields

# 3. Post-load, GLOBAL: normalize privileges to CRUD, then build the group tree.
psql "$GLOBAL_WRITER_URL" -f ../sql/migrate_authz_catalog.sql
python build_group_hierarchy.py           # dry-run: prints node/structural/roots counts
python build_group_hierarchy.py --apply   # sets path + parent_id (enables inheritance)

# 4. Test personas + login accounts, LOCAL.
python seed_test_users.py
node seed_login_accounts.mjs | psql "$LOCAL_WRITER_URL"
```

Notes:
- `build_group_hierarchy.py` matches groups by DB label (not the id maps), so no
  `--keep` is needed; the maps are destroyed after the load as designed.
- Spot-check after: `CCC_NO_Vestre Viken` = 17 device grants, `BU_AX` = 486,
  `BU_AX_DE` = 5 attribute + 6 single-system. Customer/site scopes remain
  deferred (see `docs/data_import.md` gap #2).
- The portal reads live data; just refresh -- no rebuild needed.

## WHERE TO START NEXT (priority order)

**Resume here: the remaining primary section is Customers/Sites.** Products,
Devices, Gateways, and the whole Administration section are done. Gateways is a
master-detail browser over the RS-router / communication-interface records
(Google-style search, enriched fields from `RDRSROUTERDETAILVIEWV1`, the
attached-devices relation, admin edit/create/delete); see `docs/portal_ui.md`.

0. **DONE so far** (see `docs/portal_ui.md` for detail):
   - Nucleus AppShell (top bar + icon rail) + identity model (password login ->
     `login_account` -> Persona Selector -> active `app_user` persona;
     region-prefixed text `user_id`).
   - Administration, fully built: **Accounts**, **Personas** (paginated CRUD),
     **Roles** (editable privilege matrix = CRUD verbs x extensible types),
     **Groups** (a real expandable **tree** via `GroupTree.svelte`; grants shown
     decoded; member mgmt), **Grants v1** (group-centric builder: role +
     resource-typed scope, device dims region/product/customer/site + group
     subtree, decomposed into one grant per combination; `ConfirmDialog` +
     `ScopePicker` components).
   - Data pipeline: single-system grants imported; the group hierarchy
     (`build_group_hierarchy.py`) materializes the full tree from `groups.txt`.
     Reload steps are in "Re-running the data pipeline / full reload" above.

1. **Products page** (BUILT). `/products` is a master-detail product-tree
   editor per `docs/product_admin.md`: a four-level tree (modality > product >
   model) via a `kind` discriminator, `family` on products, a `product_model`
   satellite (partno + integer serial range + host flag), a `product_model_app`
   Connect-app list (`AppEditor.svelte`; devices inherit live with full
   per-device override), and a deep link to a future central `/services/infoproxy`
   for device authorization. Model master data is imported from `RDPRODUCTMODEL`
   (`load.py`, 1386 models). Components: `ProductTree.svelte`, `AppEditor.svelte`.
   Schema: `migrate_product_model.sql`. **Remaining product follow-ups**: device
   re-pointing (`device.product_path` -> matching model by serial range) and the
   `/services` section (Infoproxy / E-Mail Relay / File Transfer).

2. **Devices page** (BUILT). `/devices` is a master-detail browser: Google-style
   search (bare terms over serial/FL/IP; qualifiers `sn:`/`fl:`/`ip:`/`tid:`/
   `host:`/`ord:`), admin `My scope | All devices` toggle, keyset pagination,
   detail view+edit of identity fields + relations (`EntityPicker` type-aheads:
   model/region/customer/site/gateway), admin create+delete (delete blocked when
   a single-system grant references the device). The device identity fields
   (serial, functional_location=IDENTIFIER3, technical_ident=SYSTEMID2,
   host_hw_id=HOSTID, order_number, ip_address/ip_real, contact) are imported
   anonymized from RDSERVICEDSYSTEM, and `product_path` now points at the **model**
   node (via PRODUCTMODELID). Schema: `migrate_device_identity.sql` (+ pg_trgm
   indexes). New APIs: `/api/administration/{models,gateways}`. **TODO**: stage-2
   debounced live search; wire the Devices browser into single-system grant
   creation in the Grants tab (now unblocked -- real device search exists).
   **Performance**: scope-mode paging is ~455ms (joins the tuned
   `authz_visible_device_ids`); the exact count (~800ms) is computed only on
   filter change (client fetch to `/devices/count`) and carried through paging
   links as `&n=` (approach A). NEXT PERF STEP: Valkey L1 cache for the count +
   the visible-id-set floor (see `docs/authz_caching.md`).

3. **Slice C -- group-membership enforcement.** Replace the interim `is_admin`
   check on Groups' add/remove member with a real group-scoped `authz_can`
   (actor -> groups (local) -> grants (global, inherited) -> role has
   `(group,edit)` and a group-scope whose subtree covers the target group). The
   Grants tab can already CREATE those group-admin grants. Keep `is_admin` as the
   section gate for now. (Persona/user-record scoping deferred; the subset guard
   deferred -- SuperUser-only today.)

4. **L0/L1 Valkey caches** per `docs/authz_caching.md`. Re-validate the perf
   benchmark now that group inheritance is live (was measured on flat groups).

5. **Real auth** (SAML/OAuth) - swap the password check in
   `src/lib/server/identity.ts` `verifyLogin` (+ `session.ts`) for the IdP; the
   person/persona split already anticipates it (callers read `locals.userId`).

6. **Deploy** - Dockerfile for `fleetshell-portal-dev` (mirror
   `fleetshell-portal/Dockerfile`, `CMD node server.js`) + an infra script for a
   new ECS service/target group behind the existing ALB with a `/dev/*` rule.

## Hard rules the next agent MUST preserve

See `docs/mdm_design.md` §5.1 — NULL-attribute = no match; graded
`access_requirement` gating; region/product are ltree subtree scopes; grant
inheritance is ancestor-or-self; grant-on-grant subset guard. These are
correctness invariants; breaking them silently leaks authorization.

## Key facts

- Region hierarchy is World > Country > State (the legacy DMZ table is VPN
  routing, not geography, so there is no clean continent layer — noted in
  `load.py`).
- `access_requirement ∈ {open, device, customer, site}` generalizes the old
  `explicit_grant_only` and propagates from customer/site "requires explicit
  grant" flags.
- The portal's `authz_list_devices`/`authz_can` signatures are stable; the fast
  path is transparent to callers.
