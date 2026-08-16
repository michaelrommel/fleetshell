# FleetShell Master Data Management + Authorization Design

Status: design agreed, implementation starting.
Scope: replaces the Valkey-only key/value store as the system of record for
device/gateway relations and authorization, while keeping Valkey as the cache
and probe/session layer.

## 1. Goals and constraints

- Model the relations between gateways, devices, customers, sites, products.
- Express authorization richer than a KV store allows.
- Two hot operations must be fast:
  - `check(user, verb, thing)` on every backend function call.
  - `list(user, verb, thing-type)` = "all things I may act on", paginated.
- Worldwide device visibility, but connections route to the device's regional
  gateway. User PII should stay in-region.

Measured scale (drives every choice below):

| Entity | Now | Expected |
|---|---|---|
| Devices | ~200k | ~400k |
| Users | ~10k | ~15k |
| Groups | ~350 | (100/country + 80 admin + business lines) |
| Customers | ~40 | most devices are flat (no customer) |
| Customer sites | ~100 | aggregate by gateway / hospital_name / single systems |
| Concurrent sessions | 500-1000 | ~60% run "list my devices" |

These numbers are small for Postgres. That single fact removes the need for the
materialized bitmap / Bloom acceleration we considered (see section 8).

## 2. Storage decision: Aurora PostgreSQL

Chosen: **Aurora PostgreSQL (Serverless v2)** as the system of record.

Rationale:
- The authorization model (user -> group -> role -> privilege, plus scopes) is
  inherently relational with many-to-many joins and hierarchy.
- The killer query, "list all things I can access, filtered/sorted/paginated",
  is a `WHERE` clause with **predicate pushdown** into indexes plus optional
  joins. Relational engines are built for exactly this.
- `ltree` gives indexed hierarchy (product tree, group nesting); `jsonb` + GIN
  covers extensible device attributes.

Rejected:
- **DocumentDB / Mongo** - the RBAC graph is relational; document stores force
  denormalization (fan-out on scope changes) or app-side joins, and the dynamic
  predicate + join + sort + paginate list query is their weak spot.
- **AppSync / DynamoDB** - GraphQL is an API layer, not a store; DynamoDB cannot
  do arbitrary predicate filtering, which is the whole problem.

GraphQL is treated as an **optional composition/API layer** (see section 7), not
a storage decision.

## 3. Two-plane architecture

Data is split by residency and replication needs.

```
GLOBAL plane  (Aurora Global Database, primary eu-west-2, read replicas per region)
  master data : device, gateway, product, customer, customer_site
  authz model : privilege, role, grant, scope, scope_constraint, scope_device
  group registry: principal_group (group_id + non-PII label + ltree nesting)

REGIONAL plane (standalone Aurora per region, never replicated out)
  user PII        : firstname, lastname, email, gender, form-of-address
  group membership: (group_id, user_id)
```

Why the split works: **grants operate on groups, so the global plane never needs
an individual user** - only the opaque `group_id`. The identifying PII and the
user<->group mapping stay regional (data residency, smaller breach blast radius).

Hot path stays local:

```
EU user connects to a US device:
  1. resolve user -> groups        REGIONAL (local, fast)
  2. groups -> grants -> scopes    GLOBAL (replicated locally, fast)
  3. evaluate scope vs device      GLOBAL master data (replicated locally, fast)
  4. connect via device.gateway    independent of DB region
```

Replication:
- Global plane uses **Aurora Global Database** (storage-level, sub-second lag,
  read-only secondaries, optional write-forwarding). Adding a region later is a
  single `create-db-cluster --global-cluster-identifier fleetshell-global` in
  that region.
- If data residency ever forbids copying the whole dataset, switch specific
  tables to **logical replication** (partial catalog) instead of whole-cluster
  Global Database.

IDs: `user_id` / `group_id` are globally unique by construction (UUIDv7 or a
region-prefix scheme). No central ID generator - that would reintroduce the
always-up global dependency the split avoids.

## 4. The authorization model ("everything is a thing")

The model is ABAC with a relationship escape hatch, generalized over resource
types so devices, groups, products, customers, sites, and grants themselves all
use one mechanism.

- A **thing** has a `resource_type`, attributes, and optionally a position in a
  hierarchy (ltree path).
- A **privilege** is `(verb, resource_type)` e.g. `(view, device)`,
  `(add_member, group)`, `(maintain, product)`, `(create, grant)`.
- A **role** bundles privileges (freely, across resource types).
- A **scope** ("where") is a set of things of one resource_type, of one of two
  kinds:
  - `attribute` - a predicate over the type's attribute space (omitted
    dimension = wildcard); **excludes** `explicit_grant_only` devices.
  - `single_system` - an explicit id list; the **only** way to reach
    `explicit_grant_only` devices (military hospitals etc.).
- A **grant** = `(who = group, what = role, where = scope)`.

Dropped from the legacy system: **service domains** (nested attribute scopes) -
only two live instances existed and they decompose into plain attribute scopes.

Grant inheritance: a grant attached to a group applies to all **descendant**
groups. Group tree is `root.ccc.ccc_de.ccc_de_military` (<= 5 levels). Resolved
with a single indexed `ltree` ancestor lookup (`grant.group.path @> user.group.path`);
no closure table, no recursive CTE needed at this depth.

Grants on grants (delegated admin): `resource_type='grant'` scopes let a Country
Admin create grants only within their bounds. Requires two things: the grant's
who/what/where projected into queryable columns (`grant_resource_type`,
`grant_verbs`), and a "can't grant what you don't hold" subset invariant enforced
at creation time.

## 5. Schema and resolution (files)

- `infrastructure/sql/schema_global.sql` - global plane tables + indexes + seed.
- `infrastructure/sql/schema_local.sql` - regional PII + membership.
- `infrastructure/sql/authz_resolve.sql` - reference `authz_can()` (check),
  `authz_list_devices()` (keyset-paginated list), `authz_effective_scopes()`
  (inheritance), and the per-constraint matcher. This is the executable spec;
  the portal generates a pushed-down `WHERE` from the same logic for any
  uncached hot path.
- `infrastructure/sql/authz_fastpath.sql` - the INDEX-USING production versions
  of `authz_list_devices()` / `authz_can()`. The reference `authz_device_in_scope()`
  is a per-row black box (planner seq-scans device x scopes = minutes at 192k);
  the fast path PIVOTS each scope into its dimensions and drives index
  nested-loops (region/product `<@` GiST, customer/site btree) as a UNION
  partitioned by scope shape. Same signatures, so callers are unchanged. Apply
  after `authz_resolve.sql`.

Device dimensions promoted to indexed columns: `country, state, modality,
product_path (ltree), customer_id, site_id, gateway_id, hospital_name,
software_version`; long tail in `attrs jsonb` (GIN). Site/customer membership is
materialized onto `device.site_id` / `device.customer_id` by a background job
that resolves `customer_site_rule` (by gateway/hospital_name) plus the static
list - so the hot path reads one indexed column, never the rule tables.

### 5.1 Implementation rules (MUST preserve in any reimplementation)

These are correctness invariants the reference SQL encodes. The portal's
app-generated pushed-down `WHERE`, any ORM, and any future rewrite MUST honor
them or authorization silently leaks.

- **NULL device attribute = does NOT match.** A constraint on a dimension where
  the device value is NULL must evaluate to `false`, never SQL NULL. In SQL,
  `col = ANY(vals)` yields NULL when `col IS NULL`, and that NULL then propagates
  through the "no constraint violated" logic and wrongly makes the scope match.
  Always guard: `col IS NOT NULL AND col = ANY(vals)` (the reference matcher
  wraps every comparison in `COALESCE(..., false)`). This was a real bug: a
  device with `site_id = NULL` leaked into a `site_id IN (...)` scope.
- **Graded access_requirement gates attribute grants.** `device.access_requirement`
  is one of `open|device|customer|site` (propagated from the device flag and the
  customer/site "requires explicit grant" checkboxes). An attribute scope reaches
  a device only when: `open`; or `customer` AND the scope has a `customer_id`
  constraint; or `site` AND the scope has a `site_id` constraint. `device` is
  reachable ONLY via a `single_system` scope. (Generalizes the old boolean
  `explicit_grant_only`, now `access_requirement='device'`.)
- **Geography is the `region` ltree** (World > Region > Country > State). Device
  `region_path` is an ID-based ltree; region scopes use `op='subtree'`
  (`region_path <@ scope_path`). `country_iso` is a denormalized display column,
  not the authz key.
- **explicit_grant_only excludes from attribute scopes.** (Legacy phrasing;
  superseded by access_requirement above.) Devices with `access_requirement`
  other than `open` are excluded from plain wildcard grants.
- **Empty attribute scope = full wildcard.** An attribute scope with zero
  constraints matches every (non-explicit) device of its type. Do not special-
  case it into "matches nothing".
- **Inheritance is ancestor-or-self.** Effective grants = grants on the user's
  groups PLUS grants on any ANCESTOR group (`grant.group.path @> user.group.path`,
  which includes equality). Groups without a path fall back to identity.
- **Two scope kinds only.** `attribute` (predicate, excludes explicit devices)
  and `single_system` (explicit id list, CAN reach explicit devices). No nested
  named-set composition.
- **Grant-on-grant needs the subset guard.** When creating a grant, the verbs
  and scope granted must be a subset of what the creator already holds
  ("can't grant what you don't hold") - enforced at write time, not by the check.

## 6. Performance and caching

See `docs/authz_caching.md`. Summary: the authorization check is not the
bottleneck; result cardinality, sort, exact counts, and connection count are.
The fixes are keyset pagination, estimated counts, an RDS Proxy connection pool,
reader-endpoint routing, and a Valkey **scope-signature** result-page cache that
collapses the login thundering herd (many users share the same visible set).

## 7. API layer (GraphQL, optional)

GraphQL earns its place only as **composition over the deliberately-split
stores** (Global Aurora + Regional PII + Valkey live status) - e.g. a device row
enriched with owner display label and online state. Use Fastify + Mercurius
self-hosted, with DataLoader batching and field-level authz. Keep the heavy
authorized **list** query as pushed-down SQL, not GraphQL resolver decomposition.
A plain REST/BFF aggregator is acceptable if composition shapes are fixed.

## 8. Deliberately not built

- **Roaring bitmaps / Bloom filters** - would optimize set membership/union, but
  our bottleneck is cardinality/sort/count/connections, not the check; they need
  a UUID->int surrogate map and a materialization/invalidation pipeline, and the
  roaring module cannot be loaded on managed AWS Valkey (ElastiCache/MemoryDB).
  Revisit only past ~10M devices or for a very high-QPS pure-check edge service.
- **Service domains** - decomposed into attribute scopes.
- **Central user_id generator** - replaced by structurally-unique IDs.
- **Tenants** - not used.

## 9. Status and next steps

**See `docs/mdm_status.md` for the authoritative current state and the
start-here handoff.** Summary:

Done:
1. Both Aurora clusters live (`make_aurora_global.sh` / `make_aurora_local.sh`).
2. Schema + `authz_resolve.sql` + `authz_fastpath.sql` applied; `seed_demo` /
   `verify_demo` green.
3. Real data imported + anonymized (`infrastructure/import/load.py`): 192k
   devices, ~1M grants, 7.7k users. Test users seeded (`seed_test_users.py`).
4. Performance validated at volume (§ `docs/authz_caching.md` §11): list
   ~330-390 ms broadest / <50 ms narrow, check 25 ms.
5. Portal dev slice (`fleetshell-portal/`): dev login, authorized device
   list, two themes, WebSocket server.

Next (priority order):
1. Portal UI: AppShell shell DONE (`docs/portal_ui.md`); next is device
   detail/view+edit, Gateways, then the Administration submenu.
2. L0/L1 Valkey caches (`docs/authz_caching.md`).
3. CRUD forms with `authz_can` enforcement + grant-on-grant subset guard.
4. Real auth (SAML/OAuth) replacing the dev session.
5. Dockerfile + ECS service + ALB `/dev/*` rule.
