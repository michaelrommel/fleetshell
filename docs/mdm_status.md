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
  AppShell (top bar + icon rail); authorized device list; Administration with
  Accounts + Personas tabs (paginated CRUD, default persona, admin-gated); two selectable themes (Nucleus
  default / Gruvbox), base-path-aware WebSocket server, postgres.js to both
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
node infrastructure/import/seed_login_accounts.mjs | psql "$LOCAL_WRITER_URL"

# 3. Portal
cp .env.example .env            # fill GLOBAL_/LOCAL_DB_PASSWORD, SESSION_SECRET
npm install && npm run dev      # http://localhost:5173/dev/login
# login super/super123 (all personas, incl. SuperUser=admin) or nora/nora123
```

Global DB password = the self-set `MASTER_PW` (Aurora Global can't use managed
secrets). Local DB password = from Secrets Manager (managed). See
`make_aurora_global.sh` STEP 5-SECRET.

## Re-running the data pipeline (if needed)

```bash
export IMPORT_GLOBAL_DSN="host=localhost port=5432 dbname=fleetshell       user=fsadmin password=... sslmode=require"
export IMPORT_LOCAL_DSN="host=localhost port=5433 dbname=fleetshell_local user=fsadmin password=... sslmode=require"
# clean, then load (see infrastructure/import/README.md + docs/data_import.md):
python load.py --stage all
python seed_test_users.py
```

## WHERE TO START NEXT (priority order)

1. **Nucleus AppShell + identity model** - DONE. The brand top-bar + icon-rail
   sidebar are built (`src/lib/components/AppShell.svelte`, `Logo.svelte`,
   `nav.ts`) and every page lives inside the `(app)` route group. Sidebar:
   Devices, Gateways, Products, Customers/Sites, Administration, then Support,
   Settings. Top bar: logo + "FleetShell Portal" left; theme toggle, bell (news
   placeholder), name/role + persona switcher, logout right. Password login ->
   `login_account` -> Persona Selector -> active `app_user` persona
   (region-prefixed `user_id`); Administration has Accounts + Personas tabs
   (paginated CRUD, non-unlinkable default persona, admin-gated). See `docs/portal_ui.md`. **Next UI work:** device
   detail/view + edit (adapt `fleetshell-portal/.../devices`), then Gateways,
   then the rest of Administration (Roles -> Groups -> Grants; grant-create last
   because of the subset guard). See `docs/portal_ui.md` §6-§7.
2. **L0/L1 Valkey caches** per `docs/authz_caching.md` (resolved-scope cache +
   scope-signature page cache). Not yet built; the DB is fast enough that it's
   only needed under the login thundering herd.
3. **CRUD forms** (groups, grants, devices) with `authz_can` enforcement and the
   grant-on-grant "can't grant what you don't hold" invariant
   (`docs/mdm_design.md` §5.1). The persona `is_admin` gate on Administration is
   an INTERIM stand-in for `authz_can(persona, 'admin', ...)`; replace it here.
4. **Real auth** (SAML/OAuth) - replace the password check in
   `src/lib/server/identity.ts` `verifyLogin` (and `session.ts`) with the IdP.
   The person/persona split already anticipates this: the IdP identifies the
   `login_account`; the Persona Selector + `account_persona` mapping are
   unchanged. Callers read `locals.userId` (active persona), so it stays
   contained.
5. **Deploy** — Dockerfile for `fleetshell-portal-dev` (mirror
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
