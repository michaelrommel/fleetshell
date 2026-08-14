# FleetShell portal-dev UI Design

Status: shell implemented; section views in progress.
Scope: the SvelteKit UI of `fleetshell-portal-dev/` (served under `/dev/`). This
doc describes the application chrome (top bar + sidebar), the routing layout,
theming, and the roadmap for the section views and Administration submenus.

The visual target is the Siemens Healthineers "Remote Service" / Nucleus look
(`fleetshell-portal-dev/theme-reference/*.png`): dark brand top-bar, an icon
rail on the left, and a content card area. The legacy portal
(`fleetshell-portal/`) has the same top-bar + sidebar concept and working
Device/Gateway view-edit pages that we adapt; the difference here is the new
theming and the master-data (Aurora) backing store.

## 1. Layout overview

```
+--------------------------------------------------------------------------+
| [logo] | FleetShell Portal          [theme] [bell] Name/Role   [logout]  |  top bar
+--------+-----------------------------------------------------------------+
| Devices|                                                                 |
| Gatewy |                                                                 |
| Prodts |                 routed page content (card area)                 |
| Custmr |                                                                 |
| Admin  |                                                                 |
|        |                                                                 |
| Supprt |                                                                 |
| Settng |                                                                 |
+--------+-----------------------------------------------------------------+
  icon rail
```

## 2. Components

| File | Role |
|---|---|
| `src/lib/components/AppShell.svelte` | Top bar + icon rail; wraps routed content. Renders the nav from `$lib/nav.ts`, holds the theme toggle, bell, name/role and logout. All colours are design tokens. |
| `src/lib/components/Logo.svelte` | Inlined Siemens Healthineers wordmark (from `theme-reference/logo.div`). Paths recolour via `--logo-fg` (default white). |
| `src/lib/components/PagePlaceholder.svelte` | Stub card for sections not yet built. Remove per-section as views land. |
| `src/lib/nav.ts` | Single source of truth for the sidebar: `PRIMARY_NAV` + `UTILITY_NAV`. |

### Top bar

- Left: `Logo` + a thin divider + the words "FleetShell Portal" (links to
  `/devices`).
- Right, from right to left as specified: **logout** button, **name / role**
  block, **bell** (news feed; red dot when `newsCount > 0`), plus a **theme**
  toggle (kept from the two-theme system; nucleus <-> gruvbox).

### Icon rail (sidebar)

Icon-over-label boxed buttons matching `nucleus_transfer_history.png`. Two
groups separated by a divider/spacer: primary sections at the top, utility
sections pinned to the bottom.

- Primary: Devices, Gateways, Products, Customers / Sites, Administration.
- Utility: Support, Settings.

Active state = lighter box (`--surface-active`) with an inset accent bar
(`--accent`). Icons are inline SVG referenced via `<use href="#i-<key>">`; the
`icon` key lives in `nav.ts`, the markup in `AppShell.svelte`.

## 3. Routing

The chrome lives in a SvelteKit route group so the login page stays bare.

```
src/routes/
  +layout.svelte              global: imports app.css only
  login/                      password login (no shell)
  select-identity/            persona picker (no shell; also the switcher target)
  logout/  theme/  api/       endpoints
  (app)/                      <- everything inside gets the AppShell
    +layout.server.ts         guard: account -> persona; loads name/role/isAdmin/canSwitch
    +layout.svelte            renders <AppShell>; opens the live WebSocket
    +page.server.ts           '/' -> redirect to '/devices'
    devices/                  authorized device list (authz_list_devices)
    gateways/ products/ customers/ support/ settings/   stubs
    administration/           admin-gated; tabbed sub-nav
      users/                  built (personas + accounts CRUD)
      roles/ groups/ grants/  stubs
```

The base path is `/dev` (`svelte.config.js`), so a nav `href` of `/devices`
renders at `/dev/devices`. `AppShell` prefixes `base` for every link and for the
active-route check.

## 4. Theming

`src/app.css` defines tokens under `:root`/`[data-theme='nucleus']` (default)
and `[data-theme='gruvbox']`. `hooks.server.ts` injects `data-theme` at SSR to
avoid a flash. The top-bar toggle flips the attribute instantly and POSTs to
`/dev/theme` to persist (cookie + DB). Add a light Nucleus variant later as its
own `[data-theme='...']` block; the shell needs no changes because it only reads
tokens. `--logo-fg` should be overridden in any light theme.

## 5. Identity, login and the persona switcher

The local plane separates the **person** from the **working identity**:

- `login_account` (the human): `username` + `email` + `password_hash` (dev; SAML/
  OAuth internal id later). One row per person.
- `app_user` (the persona = authz subject): region-prefixed text `user_id`
  (`eu:123`), name, `role_label` (display), `is_admin` (interim capability gate),
  plus `group_membership` -> effective grants.
- `account_identity` (N:M): which personas a person may assume.

See `docs/mdm_design.md` (two-plane split) and
`infrastructure/sql/migrate_identity_local.sql` (+ the updated `schema_local.sql`).
Only `group_id` crosses to the global authz plane, so making `user_id` text has
no authz-function impact.

### Flow

```
/login (password)  ->  verify login_account
     |                     |
     |            0 personas -> error
     |            1 persona  -> set session {account, persona} -> app
     |           >1 personas -> set session {account, null}    -> /select-identity
     |
/select-identity   ->  pick persona -> session {account, persona} -> app
```

Session (`src/lib/server/session.ts`) is a signed cookie carrying `accountId`
(who authenticated) + `userId` (active persona, or null before selection).
`hooks.server.ts` sets `locals.accountId` + `locals.userId`. The `(app)` guard:
no account -> `/login`; account but no persona -> `/select-identity`; otherwise
render.

### Switcher and gating in the shell

- **Name**: active persona "Lastname, Firstname".
- **Role**: `role_label` if set, else group-count fallback. Display only.
- **Switch identity**: when the account has >1 linked persona the name block
  becomes a control (caret) linking to `/select-identity`; you can jump between
  personas live (SuperUser <-> BURepresentative) to demo the grant concept.
- **Grayed-out rights**: the Administration rail item is disabled unless the
  active persona `is_admin`; the Administration routes + actions re-check it
  server-side. `is_admin` is an INTERIM stand-in for `authz_can(persona, 'admin',
  ...)`; per-action grant gating replaces it as CRUD lands.

Relevant files: `src/lib/server/{identity,password,session}.ts`,
`src/routes/{login,select-identity}/`, `src/routes/(app)/+layout.server.ts`.
Bell/news is still a placeholder (`newsCount` = 0, `TODO(news)`).

## 6. Section views (roadmap)

Order matches the agreed next steps. The Device and Gateway view-edit pages are
adapted from `fleetshell-portal/src/routes/(app)/{devices,gateways}` (they work
well); the adaptation swaps the Valkey lookups for the Aurora master-data reads
(`authz_list_devices` / `authz_can` + detail queries) and re-skins to the tokens.

1. **Devices** (in progress): keep the authorized list, then add a detail/view
   card (serial, material, product, region, customer/site, gateway, connection
   status) and an edit form gated by `authz_can(..., 'edit', device)`. Adapt the
   layout from the legacy device page.
2. **Gateways**: list + view-edit adapted from the legacy gateway page.
3. **Products**: browse the product tree (ltree), view/maintain product nodes.
4. **Customers / Sites**: customer list with their sites; view-edit;
   `access_requirement` (open/device/customer/site) surfaced.
5. **Administration**: users, groups, roles, grants (see §7).
6. **Support / Settings**: client download + enrollment; personal prefs
   (including the theme, redundant with the top-bar toggle).

## 7. Administration submenu

Administration is the authz-admin surface: a section with a tabbed sub-nav
(`administration/+layout.svelte`) rendered inside the content card. The whole
section is admin-gated (`administration/+layout.server.ts` + per-action checks).

| Tab | Status | Purpose | Backing |
|---|---|---|---|
| Users | **built** | Manage personas and login accounts (below). | local `app_user` / `login_account` / `account_identity` / `group_membership` (+ global `principal_group` for labels) |
| Roles | stub | List roles and the privileges they bundle. | global `role` / `privilege` |
| Groups | stub | Browse the group tree (ltree), view members and grants. | global `principal_group` + local membership |
| Grants | stub | View/create grants `(group, role, scope)`. **Hardest**: enforce `authz_can(..., 'create', grant)` and the grant-on-grant subset guard (`mdm_design.md` §5.1). | global `grant` / `scope` / `scope_constraint` |

Build order for the rest: Roles (read) -> Groups (read + membership) -> Grants
(read) -> Grants (create, with the subset guard).

### Users tab (built)

Two columns, each a list + create form + detail panel (selection via `?persona=`
/ `?account=` query params, mutation via named form actions in
`administration/users/+page.server.ts`, all `requireAdmin`-guarded):

- **Personas**: search/list; create (name, `role_label`, `home_region`,
  `is_admin`; `user_id` auto-generated `<region>:<seq>`); edit; add/remove group
  memberships via a type-ahead over `principal_group`
  (`/api/administration/groups?q=`).
- **Login accounts**: list; create (username, email, password -> scrypt hash);
  link/unlink personas (`account_identity`).

This is the "add users for testing" surface: create a persona with specific
memberships (its rights), then a login account linked to several personas to
exercise the identity selector and the grant concept end-to-end.

Seed for a working starting point: `seed_test_users.py` (6 personas) ->
`migrate_identity_local.sql` -> `seed_login_accounts.mjs` (labels + accounts
`super/super123` covering all 6, `nora/nora123` single-persona).

## 8. Hard rules carried into the UI

Any list or check the UI performs MUST go through `authz_list_devices` /
`authz_can` (or the same pushed-down predicate), never an ad-hoc query, so the
`mdm_design.md` §5.1 invariants hold (NULL-attribute = no match; graded
`access_requirement`; ltree subtree scopes; ancestor-or-self inheritance;
grant-on-grant subset guard). Write forms enforce `authz_can` server-side in the
`+page.server.ts` action, never trusting the client.
