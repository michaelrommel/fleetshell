# MDM Rebuild — START HERE (agent handoff)

This is the entry point for the Master Data Management + authorization rebuild.
Read this first, then `docs/mdm_design.md` (architecture), `docs/authz_caching.md`
(performance), `docs/data_import.md` (bulk import), and
`docs/data_classification.md` (the data-classification feature + its import
pipeline).

## What this is

Replacing the Valkey key/value store as the system of record for
device/gateway/customer relations and authorization. A brand-new SvelteKit
portal (`fleetshell-portal/`, served at the site root) reads from Aurora
PostgreSQL instead of Valkey. The retired legacy portal was moved to
`fleetshell-portal-old/` (kept for reference; no longer built or deployed).

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
- **Portal dev slice working** (`fleetshell-portal/`): password login for a
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
npm install && npm run dev      # http://localhost:5173/login
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

**Resume here (NEXT SESSION): the Info Proxy runtime is now BUILT** (spooler +
Squid helper). **Services > Infoproxy** is fully built end to end -- schema, legacy
import, UI, and now the Valkey spool + `external_acl_type` helper. `spoolValkey`
is wired (the "Save to Valkey" button on the Infoproxy page); a standalone
`scripts/spool-infoproxy.mjs` mirrors it for cron/CI. New helper
`src/lib/server/infoproxy.ts` flattens binding->collection->rule into a
per-source-IP allow-list keyed `infoproxy:<proxy_type>:<source_ip>` (SET of
TAB-delimited `dns\tcidr\tport_from\tport_to\tprotocol` members; missing key =
default DENY). The Squid `external_acl_type` helper is
the Rust top-level package `squid-infoproxy` (blocking rustls/ring RESP client;
O(1) SMEMBERS on %SRC, matches %DST/%PORT; protocol advisory unless
`--strict-proto`; one instance per proxy type). Remaining: DEPLOY the helper on the actual Squid hosts + a scheduled
spool refresh; optional Secrets-Manager hardening. See item 3 for the model.

**Blocked on a data export:** real **multi-site customers** cannot be imported
from the current dump -- `RDSERVICEDSYSTEM.CUSTOMERID` is empty for every device
and there is no customer master file, so `load.py` synthesizes one customer per
site (4269:4269). The owner is obtaining a fuller legacy export (customer master
+ customer<->site + site-membership). When it lands: wire it into `load.py` and
drop the synthetic-customer fallback. See `docs/data_import.md` gap #2.

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

**Resume here: the Customers / Sites page is now BUILT** (see below). Remaining:
the device **per-device app override** (`device_app`), then **Services >
Infoproxy** + the Valkey spool, and the per-service DTM TO resolvers.

### Customers / Sites (BUILT)

`/customers`: customer browser (search name/country/city) + master-detail. A
customer has name, country (ISO picker), city/postcode/street, requires-explicit-
grant, and DTM variant (`customer.dtm_variant` -> the DTM runtime variant
selector). Under it, its **sites**; a site adds the same address fields plus
three membership methods and a **contacts** list (`customer_site_contact`:
name/role/email/phone/note, `ContactsEditor.svelte`). Membership
(`SiteMembershipEditor.svelte`): assigned **gateways** (rule; all devices behind
them join), **hospital names** (rule; matched on `device.hospital_name`), and
manual **customer systems** (`customer_site_member_static`). A device has ONE
`site_id`; `resolve_site_membership()` (in `migrate_customer_site.sql`)
materializes it with precedence manual > gateway > hospital (ties by site
created_at, id), run on every membership/site change. Static membership is
seeded from the imported `device.site_id` post-load (reload.sh) so the resolver
reproduces current memberships (verified: 0 changed). New API:
`/api/administration/devices` (device type-ahead). Reuses `ScopePicker`.

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

### Session recap (latest work, all in `fleetshell-portal` unless noted)

- **Rotating DB credentials -- runtime Secrets Manager fetch (no restart on rotation).**
  ECS injects `secrets`/`valueFrom` ONLY at task start, so a rotated master
  password (the LOCAL RDS-managed secret rotates on a multi-day schedule; the
  GLOBAL self-managed `fleetshell/global/master` on manual change) silently broke
  the running portal with `password authentication failed for user "fsadmin"`
  until the task was replaced. Fix:
  - New `src/lib/server/secrets.ts` -- fetches the DB credential secret via the
    task role and caches it for the PROCESS LIFETIME (no TTL: a per-connection
    Secrets Manager round-trip was a hot-path regression, ~10s vs ~1s). Only an
    actual auth fault re-fetches.
  - `src/lib/server/db.ts` -- when `${prefix}_DB_SECRET_ARN` is set, postgres.js
    gets a dynamic `password` callback returning the cached secret (applied per
    physical connection at auth time; see `Pass()` in `postgres/src/connection.js`).
    A ONE-SHOT retry (`retryableQuery`) fires only on `28P01`: it
    `invalidateDbSecret()`s and transparently replays the query on a fresh
    connection, which re-fetches the rotated password. Scope: plain `await` +
    chainable builders (`.values()` etc.); streaming (`.cursor()`) and
    transactions (`.begin`) pass through un-retried. Falls back to the static
    `${prefix}_DB_PASSWORD` env when no ARN is set (local dev via SSH/SSM tunnel).
  - `infrastructure/deploy_portal_taskdef.json` -- DB user/password are no longer
    `valueFrom` secrets; instead `GLOBAL_DB_SECRET_ARN` / `LOCAL_DB_SECRET_ARN`
    are plain env vars the portal reads at runtime. `package.json` adds
    `@aws-sdk/client-secrets-manager`.
  - **IAM (required before deploy):** the runtime fetch uses the TASK role
    (`ecsTaskExecutionRoleWithSSM`), NOT the execution role -- it must hold
    `secretsmanager:GetSecretValue` on BOTH DB secret ARNs (+ `kms:Decrypt` if a
    CMK is used). Policy example in `infrastructure/deploy_portal.sh` header.
  - Manual password reset (when a DB drifts from its secret): LOCAL uses
    `aws rds modify-db-cluster --rotate-master-user-password` (RDS re-syncs DB +
    managed secret in one step); GLOBAL is self-managed, so set
    `--master-user-password` on `fleetshell-global-euw2` AND `put-secret-value`
    into `fleetshell/global/master` yourself (Global clusters cannot use RDS-
    managed passwords). RDS Proxy (global) reads the same secret, so it re-syncs
    automatically.

- **Devices detail page latency (was ~1.1s server, DB only ~71ms).** A
  `Server-Timing` header on the devices `load` (visible in DevTools > Network >
  Timing) attributed the request per segment: `persona`, `groups`, `sig`, `list`,
  `detail`, `rec`. It showed `rec;dur=613` (the Recordings two-grant gate) as 55%
  of the request and that all segments ran SERIALLY. Two fixes (the header stays
  in place for ongoing measurement):
  - **#1 Recordings tab checked on click, not on load.** `recordingsAllowed()`
    (the `resolveGroupIds` + `canService('screen_recording')` + `can(device)`
    gate) is REMOVED from the page loader; `canRecordings` no longer exists in the
    page data. The **Recordings tab is always shown** for a selected device; the
    two-grant check happens client-side when the tab is opened, via the existing
    `/api/devices/recordings` fetch (which already re-enforces both grants). New
    client states: a centered spinner (`Checking access...`) during the check and,
    on HTTP 403, a centered box **"You do not have the grants to view this
    information."** (`.rec-denied` / `.rec-checking` in `devices/+page.svelte`).
    No security change -- the API was always the real enforcement point.
  - **#2 Detail load parallelized.** `loadDetail` depends only on `sel` (GLOBAL
    plane) and is independent of the persona/authz/list chain, so it is kicked off
    as `detailP` at the top of the loader and awaited at the end -- it now overlaps
    the list path instead of running after it. (Server-Timing segments will now
    SUM to more than wall-time, which is the parallelization showing up.)
  - Net: the ~613ms `rec` gate leaves the hot path and `detail` hides under the
    list chain -> remaining serial cost ~`persona+groups+sig+list` (~320ms).
  - NOT done (analyzed, deferred by owner): #3 the list/detail layout+page split
    to stop resending the 50-row list on `sel`-only clicks (SvelteKit re-runs the
    whole page `load` because it reads `sel`; a `+layout.server.ts` keyed on
    `q/mode/page/cursor` only would let a `sel` change skip the list load). Left
    out for its fragile "layout must never read `sel`" invariant; navigation
    semantics are unaffected either way. The ~50ms-per-call Valkey latency and the
    point-check `authz_can*` cost (~300ms each) are also still open.

### Session recap (services + recordings)

  **service resource type** (feature entitlement) + the device **Recordings** tab.
  - Schema `migrate_services_authz.sql` (folded into `schema_global.sql`; in
    `reload.sh` after `migrate_authz_catalog.sql`). Fully ADDITIVE and idempotent
    (new resource_type rows, new privileges, new `service` table + seed, new
    CREATE-OR-REPLACE functions; touches nothing existing code reads -- safe to
    apply to a DB a running older portal shares):
    adds the `service` resource_type + CRUD verbs (no bespoke action verb), the `service` ltree
    catalog table (`kind` root|category|service, stable `key` for seeded nodes),
    and seeds the agreed tree (Global Services / Remote Access / Data Transfer /
    Software Distribution -> functions incl. `screen_recording`). Resolution:
    `authz_can_service(groups,verb,path)` (ltree subtree point-check, sibling of
    `authz_can` for devices), `authz_can_service_key(groups,verb,key)`, and a
    coarse `authz_has(groups,type,verb)` capability check.
  - **Services > Service Catalog** is now the FIRST tab under Services
    (`services/catalog/`, `ServiceTree.svelte` = a copy of `ProductTree`): a
    Products-Tree-style browser/editor (add category/service, rename, delete with
    child + grant-reference guards; shows grants scoped at/above a node).
    `/services` now redirects here.
  - **Grants builder** gained a third `Applies to` mode **Services** (subtree
    `ScopePicker` over new `/api/administration/services`; constraint dimension
    `service_path`, op `subtree`), and decodes service scopes in the grant list.
  - **Device detail** gained a **Recordings** tab (next to Files). The TWO-grant
    gate is `service:view` over `screen_recording` AND `device:view` over that
    device, enforced on every fetch in `api/devices/recordings`. (Superseded by
    the latest-work recap: the gate was REMOVED from the page loader and is now
    checked client-side when the tab is opened; the tab is always shown. The API
    remains the real enforcement point.) The tab is a lazy S3
    browser (device IP resolved server-side -> day -> session -> presigned ZIP).
    Ported `s3.ts` from the old portal (+ `@aws-sdk/client-s3` /
    `s3-request-presigner` pinned in `package.json`; needs `GUACD_S3_BUCKET`).
  - Design decision (agreed): the Services tree is FEATURE ENTITLEMENT; the
    device scope is REACH; a future data-class / PHI clearance layer (keyed to the
    existing `data_class` catalog) is a separate orthogonal third gate, DEFERRED.
  - TODO: the `service` writes in the catalog + grants are interim `is_admin`-
    gated (replace with scoped `authz_can('service','edit'/'create')`); recording
    PLAYBACK in-browser (`Guacamole.SessionRecording` over a presigned `.guac`);
    the deferred PHI clearance gate.

### Session recap (previous work, all in `fleetshell-portal` unless noted)

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
  **Gateway authorization is now ENFORCED** (mirrors devices): a new
  `gateway.region_path ltree` (backfilled from the region catalog by name) is the
  authz dimension; `authz_visible_gateway_ids` / `authz_list_gateways` /
  `authz_can_gateway` (region-subtree + full-wildcard; no product/customer/site/
  single_system/access_requirement) drive the list. The gateways page has the
  device-style `My scope | All gateways` admin toggle + scope-signature L1
  caching (`list:gw:*` / `count:gw:*`). Grants are authored via the Grants
  builder's new **Gateways** resource type (region-only scope). Schema:
  `migrate_gateway_authz.sql` (in `reload.sh` AFTER import, since the backfill
  needs data; folded into `schema_global.sql` + `authz_fastpath.sql` for fresh
  installs). NOTE: with enforcement live and no gateway grants yet, both admins
  and non-admins see an empty scope list until a gateway grant exists -- admins
  use the `All gateways` toggle. Open follow-up: gateway DETAIL is not point-gated
  (mirrors devices; a `?sel=` outside scope still loads), and `region_path` is
  name-matched (ambiguous names -> NULL -> reachable only via a wildcard grant).
  **Legacy gateway grants now import correctly** (`load.py`): the router/gateway
  maintainer roles `SRSConfiguration` (-> gateway CRUD), `RouterConfigFunc`,
  `SRSOperation`, `router execute commands and view debug` (-> gateway view/edit)
  now produce `resource_type='gateway'` region-subtree scopes instead of device
  scopes (`GATEWAY_ROLES` + a role-aware branch in `stage_grants`; `SRS Manager`
  stays a region/country-admin role). Spot-checked from `RDGRANTVIEWV1`: 45,949
  legacy router grant rows -> ~2,125 distinct gateway grants across 15 grantee
  groups (8 FL-only/region-ANY rows dropped). Takes effect on the next
  `reload.sh` (TRUNCATE-and-reload); the live DB keeps the old device-typed rows
  until then.
- **Services** primary nav added (Infoproxy / E-Mail Relay / File Transfer) --
  placeholder page; the product-model page deep-links to
  `/services/infoproxy?product=<id>`.
- **Services now tabbed + File Subscriptions BUILT**
  (`services/+layout.svelte`: Infoproxy | E-Mail | File Subscriptions; `/services`
  redirects to the first tab). Infoproxy / E-Mail stay placeholders.
  **`services/subscriptions/`** has two inner tabs (a full 282x56 attach matrix
  locked the browser, so attachments are edited bidirectionally from each side):
  **Subscriber Servers**
  (delivery-target CRUD -- name/ip_address/country/use-case/comment/activated +
  delivery method ADLS|S3|SCP + root path / use-partno-folder / container-or-sub-path
  + a method-specific `auth` jsonb: ADLS service-principal or default, S3 access-key
  or assume-role, SCP user/pass; **secrets PLAINTEXT** in the jsonb, matching the
  gateway-PSK precedent; the detail lists **attached subscriptions** with remove +
  search-add, saved together via `?/saveServerSubs`), and **Subscriptions**
  (matcher CRUD -- name + optional modality/product pickers (product picker scoped
  to the chosen modality) + PCRE `pattern` + `negate`; the detail attaches the
  subscription to servers via a tickable **server grid**, saved via
  `?/saveSubServers`). Both save-set actions rewrite that side's
  `subscription_server` rows in one transaction (like the Site membership editor).
  Schema `migrate_file_subscriptions.sql` (`subscriber_server` /
  `subscription` / `subscription_server`; folded into `schema_global.sql` +
  `reload.sh`, applied live). New endpoint `/api/administration/product-picker`
  (product-UUID type-ahead, optional `mod` filter). The **"Save to Valkey"**
  spool-out button (beside the sub-tabs) is **WIRED** -- `spoolValkey` ->
  `src/lib/server/subscriptions.ts` `syncToValkey` (standalone mirror
  `scripts/spool-subscriptions.mjs`). It resolves, per device product, the
  applicable file-matcher subscriptions (global + modality-wide + product) and
  ALL their attached delivery targets, writing the product-keyed hash
  `ftp_subscriptions:<MODALITY>:<PRODUCT>` (field = subscription name; value =
  JSON `{pattern, negate, servers:[<denormalized target incl. auth AND
  `activated`>]}`) for aeroftp -- mirroring the classification
  `data_classes:<MODALITY>:<PRODUCT>` convention. Deactivated servers are NOT
  skipped (jobs are still enqueued during downtime so the backlog delivers on
  reactivation); `activated` travels as data. Empty/stale keys are pruned. The
  delivery RUNTIME (aeroftp ingest -> Valkey list+pubsub -> subscription-handler
  fleet -> per-server job queues) is specified in **`docs/file_subscriptions.md`**
  and is the next thing to build (a new top-level Rust package). Remaining:
  Secrets-Manager hardening of the plaintext credentials; aeroftp reader adoption
  of the key.
- **File subscriptions imported** (`import/import_subscriptions.py`): loads the
  legacy denormalized overview (`old_database/subscription_overview_2026-05-05.xlsx`,
  gitignored) into the three tables -- **56 servers, 282 subscriptions, 297
  attachments** (14 subs on >1 server). Modality/product resolved by NAME (all
  resolve), country -> ISO, negate from the `negated` column. Legacy fields absent
  from the source default to delivery=`scp`, use_case=`compliance`, activated=true;
  the legacy IP goes in a dedicated `subscriber_server.ip_address` (the connect
  host) and the `annotation` free-text (consistent per server) in
  `subscriber_server.comment`, honoring the same `ANONYMIZE` switch as `load.py`
  (placeholder in dev, raw for the production take-over). Idempotent (upsert by
  unique name); wired into `reload.sh`
  after the group-hierarchy step (a `product` TRUNCATE CASCADE empties subscription
  + subscription_server, so it re-resolves the FKs on every reload).
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
3. **Services > Infoproxy** (proxy/Squid destination authz, filterable by product
   model). **Schema DONE** (`migrate_infoproxy.sql`, folded into `schema_global.sql`
   + `reload.sh`, applied live). **Model (3 tables):**
   `proxy_destination_rule_collection` (named container -- "iPad Rule Collection";
   NOT an authz group), `proxy_destination_rule` (ONE allowed target =
   cidr/dns + port range + protocol; belongs to a collection; no scope on the
   rule), `proxy_destination_binding` (the scope: applies a collection to
   device|ANY and/or product-model|ANY; reusable). Rules always live in a
   collection. **Legacy data IMPORTED** (see below).
   **Runtime decision: Squid `external_acl_type` helper + Valkey.** A spooler
   flattens binding->collection->rule OFFLINE into a per-source-IP allow-list in
   Valkey (Squid only sees the source IP; device modality/product/serial resolved
   at spool time via device.ip -> device -> model -> matching bindings). The helper
   does an O(1) `%SRC` lookup + dst/port/proto match; Squid caches the verdict. This
   scales to the single-system-binding volume where pre-generated squid.conf fast
   ACLs would not (linear http_access scan). **Legacy data IMPORTED**
   (`import/import_infoproxy.py`): schema gained `proxy_type` (intranet|internet);
   parses `infoproxy_rules_intranet.txt` (intranet: named collections + rules +
   assignment table) + `infoproxy_rules_internet.txt` (internet collection defs) +
   **`table-export.html`** (the authoritative HTML export of the internet
   "2226 items" assignment grid -- clean 10 columns; supersedes the scrambled
   `info_proxy_internet.txt` PDF text) into **16 collections / 391 rules / 2198
   bindings**: intranet = 2 named + 91 global inline (synthetic "Intranet Global"),
   all ANY/ANY; internet = 12 named + 32 inline (synthetic "Internet Global") +
   **2111 device-precise** + **75 model-scoped** + 8 global bindings. Per-device
   attribution: Customer System == `RDSERVICEDSYSTEM.NAME` (2112/2112 match),
   resolved via `sysname_device.map.json` (NAME->device UUID, written by load.py
   stage_devices). In `reload.sh` after `import_subscriptions.py`. **UI BUILT**
   (`services/infoproxy/+page.*`): SplitPane -- left = collection list (single-line
   rows like admin>Roles: name left, right-aligned `N url` chip + `N mdl` / `N sys`
   counts or `ANY`) with search
   + two proxy-type chips (Internet/Intranet, both on by default) + `+ New`; right
   = two sub-tabs **Destinations** (permitted-URL rules grid, replace-all
   `?/saveRules`) and **Applies to** (three-tier scope: global `All systems`
   checkbox `?/toggleAny`; **Product models** `ScopePicker` over
   `/api/administration/models` replace-all `?/saveModels`; **Individual systems**
   searchable/incremental via `/api/administration/proxy-binding` GET/POST/DELETE,
   scales to 2000+ devices; the filter does AND-of-terms over serial/IP/FL/hospital
   /**model name**). Deep link `?product=<model>` filters to collections
   bound to that model OR ANY (wired from the product-tree "View destinations"
   link). Binding uniqueness via partial unique indexes (device/product/ANY). The
   `Save to Valkey` spool-out button is **WIRED** (`spoolValkey` ->
   `src/lib/server/infoproxy.ts` `syncToValkey`). `/api/administration/models`
   now also returns `id`.
   **Spool BUILT** -- `src/lib/server/infoproxy.ts` (+ standalone
   `scripts/spool-infoproxy.mjs`) flattens binding->collection->rule into a
   per-source-IP Valkey allow-list (per proxy_type; intranet vs internet are
   separate Squids), keyed `infoproxy:<proxy_type>:<source_ip>` = SET of
   TAB-delimited `dns\tcidr\tport_from\tport_to\tprotocol` members (device->model
   via `product.path = device.product_path`; missing key = default DENY; each key
   rewritten single-key DEL+SADD, stale keys UNLINKed). The Squid
   `external_acl_type` helper is the Rust top-level package `squid-infoproxy`
   (blocking rustls/ring RESP client; O(1) SMEMBERS on %SRC + %DST/%PORT match,
   protocol advisory unless `--strict-proto`; run one instance per proxy type;
   Squid config example in `squid-infoproxy/README.md` + the crate docstring). **NEXT (deploy-only): put the helper on the Squid hosts +
   schedule the spool refresh.** The **device + gateway Valkey spool** is now
   BUILT (see `docs/valkey_spool.md`): write-through on device/gateway save into
   `systems:by-ip:<ip>` (aeroftp: modality/product/partno/serial/country/dtm/
   contracts) and `fleetipsec:{psk,site,nat}:<public_ip>` (ipsecnode: crypto +
   NAT with per-device `nat_mode`). Verified against ipsecnode (arrays OK,
   customer_id unused, backend_nat optional). The DynDNS password would come from
   the source `WEBDNSPWID`/`WEBDNSPWPW` in production.
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

6. **Deploy** - Dockerfile for `fleetshell-portal` (custom `server.js` entry,
   `CMD node server.js`) + `scripts/build_portal.sh` (buildx -> ECR). Serves at
   the site root (BASE_PATH empty); replaces the running portal container.
   The ECS task-def migration (env + secrets: Aurora Global via RDS Proxy, Local
   via cluster endpoint, Valkey, JWT/CLIENT_CERT/CLIENT_KEY/SESSION_SECRET from
   Secrets Manager) is scripted in `infrastructure/deploy_portal.sh` (cluster
   `aeroftp-cluster`, service `fleetshell-portal-service-v6kb01vb`). Client
   cert/key are env-injected (`CLIENT_CERT`/`CLIENT_KEY`, already wired as
   secrets) -- there is NO `certs/` directory; when unset the cert endpoints
   return a PLACEHOLDER (dev only).

## Hard rules the next agent MUST preserve

See `docs/mdm_design.md` §5.1 — NULL-attribute = no match; graded
`access_requirement` gating; region/product are ltree subtree scopes; grant
inheritance is ancestor-or-self; grant-on-grant subset guard. These are
correctness invariants; breaking them silently leaks authorization.

### Authorization principle: `is_admin` is NOT god-mode

Separate **administering the system** from **operating on the data**:

- **Operational / sensitive functions** (device Recordings today; future
  data-class / PHI access, `device:connect`, etc.) are gated on **real grants**
  via `authz_can` / `authz_can_service`, and **deliberately ignore `is_admin`**.
  A SystemAdmin/SuperUser sees NO recordings tab (and no PHI) unless a grant
  confers it -- proven in practice: the tab correctly stayed hidden for an
  is_admin persona that lacked `service:view`. **Do NOT "fix" a hidden
  operational feature by making its gate honor `is_admin`** -- that reintroduces
  god-mode and silently leaks access.
- **Admin *section* management** (Products / Groups / Roles / Grants / catalog
  writes) is still gated on the **interim `is_admin` flag** (scaffolding). Slice C
  replaces this with scoped `authz_can(...)`. `is_admin` should shrink to a
  **bootstrap capability** -- "may manage roles/grants/accounts" (so the first
  grants can be assigned; avoids a chicken-and-egg lockout) -- and MUST NOT grow
  back into implicit access to operational functions. Managing *who may view
  recordings* is an admin act; *viewing a recording* (PHI) is an operational act
  needing its own grant, even for the person who handed out the grants.

## Key facts

- Region hierarchy is World > Country > State (the legacy DMZ table is VPN
  routing, not geography, so there is no clean continent layer — noted in
  `load.py`).
- `access_requirement ∈ {open, device, customer, site}` generalizes the old
  `explicit_grant_only` and propagates from customer/site "requires explicit
  grant" flags.
- The portal's `authz_list_devices`/`authz_can` signatures are stable; the fast
  path is transparent to callers.
