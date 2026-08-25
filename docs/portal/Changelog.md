# FleetShell Portal - Changelog

Human-facing record of notable portal (`fleetshell-portal`) changes: features,
UI/UX, authz, and schema touch-points. Newest first. Dates are `YYYY-MM-DD`.

Keep entries short and grouped by change-set. When a change needs a DB migration
or a `reload.sh` step, say so explicitly.

---

## 2026-08-25

### Groups: top-level section + delegated (non-admin) group administration

- **New primary nav item "Groups"** (two-person icon) between Products and
  Services (`src/lib/nav.ts`, `src/lib/components/AppShell.svelte`).
- **Moved the Groups UI out of Administration** (which is `is_admin`-gated) to a
  new top-level route `src/routes/(app)/groups/`. The old
  `administration/groups/` route and its Admin sub-tab were removed.
- **Delegated group admin (ABAC).** A non-admin persona holding a group-scoped
  grant (GroupAdmin role over a `group_path` subtree) can now **fully manage that
  subtree**: add/remove members, rename, and create sub-groups. Deleting a group
  and creating a new root group stay `is_admin`-only. `is_admin` personas keep
  unrestricted control.
  - Non-admins see only their granted subtree; a subtree's top node is re-rooted
    so it renders as a tree root (its real, hidden parent is dropped).
  - Every action re-checks authorization server-side (`requireGroupEdit` /
    `requireAdmin`); the UI `caps` flags are mirror-only, not the enforcement.
- **New authz fast-path functions** (`infrastructure/sql/migrate_group_authz.sql`,
  added to `reload.sh` after `migrate_gateway_authz.sql`):
  - `authz_visible_group_ids(groups, verb)` - the group ids a group set may
    `verb` (their `group_path`-subtree grants, or a full wildcard).
  - `authz_can_group(groups, verb, target)` - point check
    (`target.path <@ granted group_path`, or wildcard).
  - Helpers `canGroup()` / `visibleGroupIds()` in `src/lib/server/authz.ts`.

### Grants: correct display of every scope resource type, everywhere

- **Fixed:** a group-scoped grant (and gateway/service/product/customer/site
  scopes) rendered as a wide-open **device** grant (`ANY | ANY | ANY`) on the
  Groups page, because that page's query/renderer only knew system-vs-device.
- **Centralized grant-scope decode + display** so all grant-listing pages
  (Grants, Groups, Personas) stay in lock-step:
  - `src/lib/grantScope.ts` - shared `GrantScope` type + `grantScopeColumns(sql)`
    SQL SELECT-list fragment (region/product/customer/site/group/service/
    single-system decoders). Replaces three copy-pasted query blocks.
  - `src/lib/components/GrantScope.svelte` - shared renderer covering `system`,
    `group`, `gateway`, `service`, `product`, `customer`, `site`, `region`, with
    the device triple as fallback for `device` + admin-only types
    (`role`/`grant`/`account`/`persona`). `sep` prop selects the divider.
- Adding a future resource type now means one branch in the component and (if it
  uses a new dimension) one line in `grantScopeColumns` - not three divergent
  pages.

### Persona search: multi-word queries + shared predicate

- **Fixed:** searching a full name (e.g. `Michael Rommel`) found nothing, because
  the query matched each column against the whole string (`firstname` and
  `lastname` are separate columns). Now the query is **tokenized on whitespace**:
  every token must match some field (AND across tokens, OR across fields), so
  word order does not matter and single-token search still works.
- **Removed the duplication that caused it.** The match predicate lived in two
  places (the Admin > Personas list `load` and the
  `GET /api/administration/personas` picker); fixing one missed the other.
  Extracted to a single `personaSearchFilter(sql, q)` helper
  (`src/lib/server/personaSearch.ts`) used by both. They remain separate
  endpoints by design (paginated browse vs. lightweight type-ahead) but share the
  matching logic.
- **Access:** the picker endpoint is now reachable by an `is_admin` persona OR a
  group admin (holds a `group:edit` grant), so a delegated group admin can search
  personas for the Groups "Add a member" flow after losing `is_admin`.
