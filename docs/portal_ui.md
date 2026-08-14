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
  select-persona/            persona picker (no shell; also the switcher target)
  logout/  theme/  api/       endpoints
  (app)/                      <- everything inside gets the AppShell
    +layout.server.ts         guard: account -> persona; loads name/role/isAdmin/canSwitch
    +layout.svelte            renders <AppShell>; opens the live WebSocket
    +page.server.ts           '/' -> redirect to '/devices'
    devices/                  authorized device list (authz_list_devices)
    gateways/ products/ customers/ support/ settings/   stubs
    administration/           admin-gated; tabbed sub-nav
      accounts/               built (login accounts; default + linked personas, paginated)
      personas/               built (identities; search, paginate, group memberships)
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
- `account_persona` (N:M): which personas a person may assume.

See `docs/mdm_design.md` (two-plane split) and
`infrastructure/sql/migrate_identity_local.sql` (+ the updated `schema_local.sql`).
Only `group_id` crosses to the global authz plane, so making `user_id` text has
no authz-function impact.

### How identities link to grants (NOT per group)

```
groups --carry--> grants (scope: DE, JP+KR, ...)
  ^
  | join (group_membership)
  |
identity (app_user)  <- the authz subject; joins MANY groups, like a normal user
  ^
  | account_persona (N:M)
  |
person (login_account) -- authenticates
```

- An identity is **not** created per group. One identity joins many groups
  (CCC_DE, and CCC_JP too if needed); the grants live on the groups.
- **Normal employee** = one person + **one** identity that joins their groups.
  They never see the selector (single linked identity).
- **Tester / demo** = one person linked to **several** identities (a broad one
  and a narrow one) to exercise different rights live.
- A person needs **at least one** linked identity to sign in. The Accounts tab
  gives every new account a DEFAULT persona (created fresh or linked from an
  existing identity) that is always present and cannot be unlinked (see §7).

### Flow

```
/login (password)  ->  verify login_account
     |                     |
     |            0 personas -> error
     |            1 persona  -> set session {account, persona} -> app
     |           >1 personas -> set session {account, null}    -> /select-persona
     |
/select-persona   ->  pick persona -> session {account, persona} -> app
```

Session (`src/lib/server/session.ts`) is a signed cookie carrying `accountId`
(who authenticated) + `userId` (active persona, or null before selection).
`hooks.server.ts` sets `locals.accountId` + `locals.userId`. The `(app)` guard:
no account -> `/login`; account but no persona -> `/select-persona`; otherwise
render.

### Switcher and gating in the shell

- **Name**: active persona "Lastname, Firstname".
- **Role**: `role_label` if set, else group-count fallback. Display only.
- **Switch identity**: when the account has >1 linked persona the name block
  becomes a control (caret) linking to `/select-persona`; you can jump between
  personas live (SuperUser <-> BURepresentative) to demo the grant concept.
- **Grayed-out rights**: the Administration rail item is disabled unless the
  active persona `is_admin`; the Administration routes + actions re-check it
  server-side. `is_admin` is an INTERIM stand-in for `authz_can(persona, 'admin',
  ...)`; per-action grant gating replaces it as CRUD lands.

Relevant files: `src/lib/server/{identity,password,session}.ts`,
`src/routes/{login,select-persona}/`, `src/routes/(app)/+layout.server.ts`.
Bell/news is still a placeholder (`newsCount` = 0, `TODO(news)`).

## 6. Section views (roadmap)

**NEXT: Devices.** Products (below) and Administration (§7) are built.

1. **Products** (BUILT): `/products` is a master-detail product-tree
   browser/editor over the `product` ltree (modality > product > model), built
   per `docs/product_admin.md`. Left = `ProductTree.svelte` (whole tree, filter,
   kind badges, collapsed by default); right = per-kind detail: rename (all),
   `family` (product), model form (name/partno/serial range/host flag,
   integer-validated) + `AppEditor.svelte` (the Connect-app list, adopting the
   legacy fleetshell-portal port-rows layout: Name | Ports | Application | Guac |
   E2E | x with Path/SNI + Guac sub-rows; edits a local array, saves all at once
   to `?/saveApps`), a deep link to `/services/infoproxy?product=<id>`,
   add-child + guarded delete. Writes admin-gated; view open. Model master data
   is imported from `RDPRODUCTMODEL` (`load.py`).

   The two columns use `SplitPane.svelte` -- a reusable draggable split with a
   localStorage-persisted width (`storageKey`). The Administration master-detail
   tabs (Groups, Grants, Accounts, Personas) use it too.
2. **Devices** (BUILT): master-detail (`SplitPane`, storageKey `devices`).
   **Left**: a Google-style search box -- bare terms hit serial / functional
   location / IP; qualifiers `sn:` `fl:` `ip:` `tid:` `host:` `ord:` restrict to a
   field, ANDed (stage 1: runs on submit; stage 2 debounced live search TODO) --
   an admin **My scope | All devices** toggle (scope = `authorizedDeviceIds`,
   all = whole fleet), a results table (serial / FL / model / IP / customer),
   and keyset pagination over `id`. **Right**: device detail with view + edit
   (admin) of the identity fields (serial, functional_location, technical_ident,
   host_hw_id, order_number, ip_address, ip_real, contact, hospital,
   software_version, access_requirement) and relations via `EntityPicker`
   type-aheads (product **model**, region, customer, site, gateway; save
   recomputes denormalized modality + country_iso). Admin **create + delete**
   (delete blocked when a single-system grant references the device, since
   `authz_scope_device` has no FK cascade). New APIs: `/api/administration/models`
   (kind='model') and `/api/administration/gateways`. Device identity fields +
   model re-point come from `migrate_device_identity.sql` + `load.py`
   (RDSERVICEDSYSTEM). Components: `EntityPicker.svelte`.

   **Count / performance**: the list total uses **approach A (URL-carry)** --
   the page query alone is ~455ms (scope) / instant (all, PK keyset); the
   expensive exact count (~800ms, materializes the visible-id set) is computed
   **only when the filter changes**, via a client fetch to `/devices/count`, and
   threaded through the pagination links as `&n=` so paging never recomputes it.
   Footer shows `from-to of <n>` with a spinner until the count arrives. Next
   step (see `docs/authz_caching.md`): a Valkey L1 cache for the count and the
   ~455ms visible-id-set floor (the earlier `authorizedDeviceIds` +
   `id = ANY(20000)` approach was the cause of the original 4-7s loads and is
   removed).
3. **Gateways**: list + view-edit adapted from the legacy gateway page.
4. **Customers / Sites**: customer list with their sites; view-edit;
   `access_requirement` (open/device/customer/site) surfaced. (Customer/site
   master data needs proper production exports -- see `docs/data_import.md`.)
5. **Administration**: DONE -- accounts, personas, roles, groups, grants (§7).
6. **Support / Settings**: client download + enrollment; personal prefs.

## 7. Administration submenu

Administration is the authz-admin surface: a section with a tabbed sub-nav
(`administration/+layout.svelte`) rendered inside the content card. The whole
section is admin-gated (`administration/+layout.server.ts` + per-action checks).

| Tab | Status | Purpose | Backing |
|---|---|---|---|
| Accounts | **built** | Login accounts (the sign-in entity). Each has one non-unlinkable DEFAULT persona + optional additional linked personas. | local `login_account` / `account_persona` |
| Personas | **built** | Identities (the authz subject): search, paginate, edit, group memberships. | local `app_user` / `group_membership` (+ global `principal_group` for labels) |
| Roles | **built** | Roles = named bundles of privileges. Editable privilege matrix (types x CRUD). | global `authz_role` / `authz_role_privilege` / `authz_privilege` |
| Groups | **built** | Flat group list; view grants on a group + manage members. | global `principal_group` / `authz_grant` + local `group_membership` |
| Grants | **built (v1)** | Group-centric: pick a group in the tree, view/delete its grants, add a grant (role + resource-typed scope). Device scopes (region/product/customer/site) + group scopes (subtree). Single-system create + the subset guard deferred. | global `authz_grant` / `authz_scope` / `authz_scope_constraint` |

Build order for the rest: Grants (read) -> Grants (create, with the subset
guard).

### Accounts and Personas tabs (built)

Both are master-detail with a **full-height layout**: the tab fills the viewport
(app-shell flex column with internal scroll), the searchable list scrolls
internally, and a Prev / `from-to of total` / Next bar is pinned at the bottom;
the edit panel on the right is its own scroll region (always in view).
Pagination is **keyset** (cursor over `lastname,firstname,user_id` for personas,
`username` for accounts, encoded in the URL as `after`/`before`; a `page` counter
drives the position readout) - stable under inserts and fast at any depth, no
offset. `?account=` / `?sel=` selects (preserving the list position), `?new=1`
opens the create form; actions in the tab's `+page.server.ts`, all
`requireAdmin`.

**Personas** (identities = authz subjects): create (name, `role_label`,
`home_region`, `is_admin`; `user_id` auto `<region>:<seq>`); edit; add/remove
group memberships via a type-ahead over `principal_group`
(`/api/administration/groups?q=`). Memberships are what give an identity its
rights - one identity joins many groups; grants live on the groups.

**Accounts** (login accounts): create with a DEFAULT persona that is either
freshly created OR an existing one picked via persona type-ahead
(`/api/administration/personas?q=`) - the latter is how a real/imported user is
onboarded without duplicating their identity. `account_persona.is_primary`
marks the default (partial-unique: one per account); the default shows a **View**
button (jumps to it in the Personas tab) and cannot be unlinked. Additional
identities are linked/created below, each with **View** + **Unlink**. The detail
also resets email / display name / password.

Seed for a working starting point: `seed_test_users.py` (6 personas) ->
`migrate_identity_local.sql` -> `migrate_identity_primary.sql` ->
`seed_login_accounts.mjs | psql` (labels + accounts `super/super123` covering all
6 with the first as default, `nora/nora123` single-persona).

### Roles tab (built)

The authorization vocabulary is **(fixed CRUD verbs) x (extensible types)**:
`authz_privilege(resource_type, verb)` where `verb` is the fixed set
`create/view/edit/delete` plus the one action verb `device:connect`, and
`resource_type` is a row in `authz_resource_type` (add types as portal functions
land). Starting types (11): device, gateway, product, customer, site, region,
group, role, grant, account, persona. A role (`authz_role`) is a set of ticked
privileges (`authz_role_privilege`), consumed by grants as the "what".

`migrate_authz_catalog.sql` normalizes the imported ad-hoc catalog to this
(remaps `product:maintain` -> `edit`, `group:add_member/remove_member` -> `edit`,
drops the fine-grained legacy verbs); `authz_grant` is untouched (grants
reference roles, not privileges).

UI: master-detail. Left: role list (name, privilege count, grant usage). Right:
rename; an editable **privilege matrix** (rows = types, columns = CRUD verbs +
`connect`) saved as a whole; a read-only usage readout; Create; and a guarded
Delete (blocked while any grant references the role, since `authz_grant.role_id`
has no cascade).

### Groups tab (built)

Group hierarchy: `infrastructure/import/build_group_hierarchy.py` builds the FULL
org tree from `old_database/groups.txt` (tab-indented) + strict
`BU_`/`CCC_`/`CountryAdmin_`/... naming. It **materializes structural nodes** --
labels in the file that carry no grants (so `load.py` never created them, e.g.
`All`, `CCC`, `CCC_DE`, `Support`, `Partner`) become grant-less, member-less
`principal_group` rows -- so the tree is complete and `path`/`parent_id` chain
through them. Grant-less nodes add nothing to inheritance; they only give shape.
Run `python build_group_hierarchy.py` (dry-run) then `--apply` after each data
reload (idempotent; structural nodes matched by label).

**Single User Grants:** `user:<granteeid>` entries are LEGACY personal grants;
excluded from the tree (`WHERE label NOT LIKE 'user:%'`) and left flat.
(`granteeid` = holder; `grantorid` = granter = `authz_grant.created_by`.)

UI: the left column is an **expandable tree** (whole tree loaded once, ~660
nodes; client-side expand/collapse + a filter that reveals matches with their
ancestors; roots and the selected node's ancestors auto-expand). Each node shows
grant/member counts. The right detail panel (unchanged shape): rename + region;
a collapsible **Grants on this group** list where each grant is decoded to
`Region | Product | Customer[/Site]` (single-system grants show the device
serial); **members** (count + first 50 + name filter) with add (persona
type-ahead) / remove; create, rename, guarded Delete.

### Grants tab (built, v1)

A grant is `(group, role, scope)`, and **`scope.resource_type` decides what it
governs** -- the builder is "pick a resource type, then build the scope for it."

Group-centric master-detail: left = the shared `GroupTree` (pick the **who**);
right = that group's grants (each decoded + deletable) and an **Add grant** form:
role picker (all `authz_role`), a resource-type radio (**Devices** / **Groups**),
and a scope builder of chip multi-selects (`ScopePicker` over
`/api/administration/{regions,products,customers,sites}` and the groups search):
- **device** scope: Region / Product (ltree subtree) + Customer / Site (in);
  empty dimension = ANY.
- **group** scope: Group subtree over `principal_group.path` -- the delegated-
  admin axis ("manage groups at/under CCC_DE"), reusing the group tree.

`createGrant` **decomposes** the picks into the cartesian product of the chosen
dimensions (empty = ANY) and creates one `authz_scope` + constraints +
`authz_grant` per combination (capped at 500), so 2 regions x 2 products = 4
grant lines -- matching the legacy one-line-per-combination granularity and
letting each be revoked individually. It also stores `grant_resource_type` +
`grant_verbs` for the future subset guard; `deleteGrant` drops the grant and its
now-unused scope.

Deferred (agreed): **single-system grant creation** (device serials are
anonymized in this dump -> needs the real Devices browser); the **grant-on-grant
subset guard** (only SuperUser admins exist today); and **group-membership
enforcement** (slice C: replace the interim `is_admin` on Groups' add/remove
member with a real group-scoped `authz_can`). Persona/user-record scoping is not
designed yet.

Shared components: `src/lib/components/GroupTree.svelte` (Groups + Grants) and
`ScopePicker.svelte` (chip multi-select over a search API).

## 8. Hard rules carried into the UI

Any list or check the UI performs MUST go through `authz_list_devices` /
`authz_can` (or the same pushed-down predicate), never an ad-hoc query, so the
`mdm_design.md` §5.1 invariants hold (NULL-attribute = no match; graded
`access_requirement`; ltree subtree scopes; ancestor-or-self inheritance;
grant-on-grant subset guard). Write forms enforce `authz_can` server-side in the
`+page.server.ts` action, never trusting the client.
