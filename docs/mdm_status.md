# MDM Rebuild — START HERE (agent handoff)

This is the entry point for the Master Data Management + authorization rebuild.
Read this first, then `docs/mdm_design.md` (architecture), `docs/authz_caching.md`
(performance), `docs/data_import.md` (bulk import), and
`docs/data_classification.md` (the data-classification feature + its import
pipeline).

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
psql "$GLOBAL_WRITER_URL" -f sql/migrate_data_classification.sql # data_class catalog + classification_set/rule/rule_class/assignment (data classification)

# 1. Reset the loaded/derived data (keeps schema + authz_privilege canonical seed).
#    product CASCADE also clears product_model + product_model_app via their FK.
psql "$GLOBAL_WRITER_URL" -c "TRUNCATE region, product, gateway, device, customer, customer_site, principal_group, authz_role, authz_scope, authz_grant CASCADE;"
psql "$LOCAL_WRITER_URL"  -c "TRUNCATE app_user, login_account CASCADE;"

# 2. Re-import from the legacy CSVs (fresh id maps; maps destroyed at the end).
cd import && rm -f *.map.json
python load.py --stage all                # single-system grants + product models (RDPRODUCTMODEL: ~1386 models) + device identity fields
#   NOTE: --stage all also re-applies classification.json (by product/family NAME)
#   so data classification survives the product-UUID regeneration. Nothing else needed.

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

**Resume here: the Data Transfer Matrix is now BUILT** (schema + import +
Valkey spool + editor; see below). After that, the remaining primary section is
Customers/Sites, then the
device **per-device application override** (`device_app`), then **Services >
Infoproxy** + the **Valkey spool**. Products (incl. **Data Classification**),
Devices, Gateways, and the whole Administration section are built.

### Data Classification (BUILT -- see `docs/data_classification.md`)

`/products` is now tabbed: **Product Tree | Data Classification**. The
classification tab (modality-scoped: Rule Sets / Assignments / Preview) assigns
fixed data classes to device files by filename regex and syncs the resolved
result into the Valkey hash `data_classes:<MODALITY>:<PRODUCT>` for aeroftp.
Gated by `product:edit` (Phase 1: interim `is_admin`). Real data imported from
two spreadsheets via a name-keyed, reload-survivable pipeline:
`classification_dedup.py` (xlsx -> `classification.json`, lossless
support-based dedup) + `load.py --stage classification` / `--stage families`
(re-applied by product/family NAME on every reload) + `classification_export.py`
(DB -> file round-trip). Family mapping lives in `product_families.json`;
`product.family` is populated for CT/MR (Somaris/Numaris). New files:
`migrate_data_classification.sql`, `src/lib/server/classification.ts`,
`products/{+layout,+page,classification/,tree/}`, and the four import scripts +
JSON artifacts. Remaining: a few dormant families (`Somaris 7`, security
appliances) are manual prod cleanup; automatic write-through to Valkey on edit
is deferred (currently manual "Sync to Valkey" button).

### Data Transfer Matrix (BUILT -- see `docs/data_transfer_matrix.md`)

`Countries -> Data Transfer Matrix`: per FROM-country x variant rules (destination
country x data class -> permit/deny), anchored in the origin country (Country
Manager concern; interim `is_admin`-gated). Denial-list model (only denials
stored, default permit). Schema `migrate_dtm.sql` (data_class extended with
`kind`/`mrs_id` + 12 DTM classes; `dtm_variant`/`dtm_matrix`/`dtm_deny`;
`customer.dtm_variant`) + `migrate_user_country.sql` (LOCAL `app_user.country`,
imported from `RDUSER.COUNTRYID`). Import: `dtm_dedup.py` (10 SRS workbooks ->
committed `dtm.json`, name->code via MRS id) + `load.py stage_dtm`. Editor:
grid (destination rows x class columns grouped by kind), exceptions-first view,
row/column bulk-set, Save + Export to Valkey. Valkey key is HASH-TAGGED
`dtm:{<FROM>}:<TO>:<VARIANT>` (SET of denied codes) so a whole origin country
co-locates in one MemoryDB slot -> atomic per-country swap (MULTI/EXEC) in
`src/lib/server/dtm.ts` + standalone `scripts/spool-dtm.mjs`. aerosuite reads
`SISMEMBER dtm:{<from>}:<to>:<variant> <class>` (change in progress by owner).
TODO: per-service TO resolvers (aeroftp vs remote); customer DTM-variant editor
in the Customers page; authz_can('region','edit') scoped gate.

### Countries / Region Tree (BUILT)

New top-level nav **Countries** (continent icon) with two tabs: **Region Tree**
(built) and **Data Transfer Matrix** (placeholder -- next up). Region Tree mirrors
the Product Tree: `RegionTree.svelte` (left, filter + expand/collapse over the
`region` ltree, World/level-1 excluded so countries are roots) + a detail pane
editing a node's `name` + `iso`, adding sub-regions (US states, Canada's
Atlantic/Central/East/West/Pacific), and deleting with child + device guards.
This is where the Country Manager roles (`CountryUserAdmin` /
`CountryKeyUserAdmin` / `SRS Manager`, which already hold `region:create/edit/
delete`) will maintain their country; writes are interim `is_admin`-gated
(replace with scoped `authz_can('region', ...)`). New id-based sub-regions draw
from `region_id_seq` (starts at 1e9, above all source RDREGION ids). Files:
`lib/components/RegionTree.svelte`, `countries/{+layout,+page,region-tree/,
data-transfer-matrix/}`, `infrastructure/sql/migrate_region_tree.sql`, and the
`i-countries` icon + nav entry in `AppShell.svelte`/`lib/nav.ts`.

**Import cleanup (admin regions dropped):** `load.py` now excludes legacy
"administrative regions" (`RDREGION.REGIONTYPE=1`: 140 nodes -- `_A_*`,
`_old_RSC_*`, `Administrative Region 1`) from the region import, and skips any
grant scoped to one (177 dead device constraints -- 0 devices live in them, so
effective authz is unchanged; the whole grant row is dropped, never widened to a
product/customer wildcard). These placeholders only existed to give the old
group/delegation grants a region-shaped scope; our model scopes groups natively
via `resource_type='group'` subtree scopes, and group membership IS the
authorization (no per-member execute/delegate re-check; the only surviving
"delegate" is the grant-on-grant subset guard). `reload.sh` also now applies
`migrate_region_tree.sql`. NOTE: `--stage all` already runs `stage_families` +
`stage_classification` (Data Classification is registered).

### Session recap (latest work, all in `fleetshell-portal-dev` unless noted)

- **Products** (`/products`): model tree + `AppEditor` for `product_model_app`
  (the app definitions a device inherits). App editor lets you add/remove any
  number of rows (no minimum); an app-less model shows an empty list.
- **Devices** (`/devices`): full browser (search, scope toggle, keyset paging,
  view/edit/create/delete). Now also shows **partno** (2nd line in the list +
  under Product model) and a read-only **Applications** section resolved from the
  device's model (`product_model_app` -> inherited). **City** field added.
- **Gateways** (`/gateways`): full browser + detail. Enriched from
  `RDRSROUTERDETAILVIEWV1` (name, city, gateway_model, decoded connection_type /
  operational_state, admin_ip, country), the **attached-devices** relation, and
  the **IPsec / tunnel** editor (`IpsecEditor.svelte`: public_ip + psk + ipsec
  jsonb = the legacy SiteRecord; IKE/ESP chip multi-selects). `dns_name` was
  repurposed -> nullable **`hostname`** (dynamic-IP DynDNS); `public_ip` is
  synthesized (public-looking) since the real ones lived in Valkey. Migrations:
  `migrate_gateway_enrich.sql`, `migrate_gateway_ipsec.sql`,
  `migrate_gateway_hostname.sql`.
- **Services** primary nav added (Infoproxy / E-Mail Relay / File Transfer) --
  placeholder page; the product-model page deep-links to
  `/services/infoproxy?product=<id>`.
- **Performance**: devices scope paging ~455ms (was 4-7s) via
  `authz_visible_device_ids`; exact count only on filter change (URL-carry
  approach A, `/devices/count`).
- **UI/UX consistency pass** (all dialogs): shared `.actions-bar` +
  `.act-primary`/`.act-cancel`/`.act-delete` in `app.css` -- Delete leftmost,
  Save/Create rightmost, Cancel to its left; every Delete is **red** and routed
  through **`ConfirmDialog`** (no more `confirm()`/`alert()`). Also:
  `SplitPane.svelte` (draggable, width persisted per page), dark scrollbars,
  `EntityPicker` redesigned (value + Change), in-field search x + keep-focus on
  Enter, responsive breakpoint 960->1200px.
- New components: `ProductTree`, `AppEditor`, `EntityPicker`, `SplitPane`,
  `IpsecEditor`. New endpoints: `/api/administration/{models,gateways}`,
  `/devices/count`.
- New migrations (apply order = the reload flow above, step 0):
  `migrate_product_model.sql`, `migrate_device_identity.sql`,
  `migrate_gateway_enrich.sql`, `migrate_gateway_ipsec.sql`,
  `migrate_gateway_hostname.sql`, `migrate_region_tree.sql` (region id sequence;
  apply after `migrate_region_access.sql`).
- **Note**: `product_model_app` is currently **empty** in the DB (no model has
  apps defined yet -- legacy per-device configs were not migrated). Define apps
  on a model via the AppEditor and its devices inherit them live.

### Next up

1. **Customers / Sites page** -- the last primary section (customer list + sites,
   view-edit, `access_requirement` surfaced). Customer/site master data still
   needs proper production exports (`docs/data_import.md`).
2. **Per-device application override** (`device_app`): a `device_app` table +
   migration, `resolve_apps` (device rows override else the model's
   `product_model_app`), and an override editor (reuse `AppEditor`) with
   revert-to-model. The device page currently shows the inherited list read-only.
3. **Services > Infoproxy** (proxy destination authz, filterable by product
   model) + **Valkey spool** for the gateway IPsec (`fleetipsec:site:<public_ip>`
   / `fleetipsec:psk:<public_ip>` from `gateway.ipsec` / `gateway.psk`) so a test
   device can actually connect. The DynDNS password would come from the source
   `WEBDNSPWID`/`WEBDNSPWPW` in production.
4. **Single-system grant creation** in the Grants tab -- now unblocked by the
   real device browser (device serials/FL exist).

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
