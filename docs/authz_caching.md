# Authorization Caching & List Performance

How FleetShell keeps "list all devices I can access" fast at 500-1000 concurrent
portal sessions where ~60% run that query. Companion to `mdm_design.md`.

## 1. Load model: concurrency is not QPS

A session is a person looking at a page. The list query fires on page load,
filter change, or pagination, then the user reads for many seconds. Steady state
is tens of QPS. The real risk is the **thundering herd**: at shift start a few
hundred users open the dashboard within a second or two, all firing
"list my devices" at once. Design for that burst, not for sustained hundreds of
QPS.

## 2. The real cost drivers (not the authz check)

Over 400k indexed, static-attribute devices the authorization predicate is
milliseconds. What actually costs:

1. **Result cardinality** - a country admin's `MR/*` in DE may match 100k rows.
   Never return them all: page-1 + cursor.
2. **Sort + exact count** - `ORDER BY ... LIMIT` over a huge matched set, and
   especially `COUNT(*)` of it, are the expensive operations.
3. **Connections** - a few hundred simultaneous raw connections exhaust Postgres
   (it degrades past a few hundred). Most likely thing to actually bite.

Every fix below targets these three, not the authz model.

## 3. Layered fast path

```
 request: list(verb, filter F, sort S, cursor C) for user U
    │
    ├─ L0  Valkey: resolved authorization for U
    │      key   authz:user:{U}
    │      value { effective scope set, scope-signature }
    │      TTL   5-15 min; invalidated on grant/membership/role change
    │      role  removes group/grant/role/inheritance joins from every request
    │
    ├─ L1  Valkey: cached RESULT PAGE  (the herd killer)
    │      key   list:{scope-signature}:{F}:{S}:{C}
    │      value serialized page (rows + next cursor)
    │      TTL   30-60 s
    │      hit   return immediately, no DB touch
    │
    └─ L2  miss -> Aurora READER (Serverless v2 / replica) via RDS Proxy
           keyset pagination + estimated count
```

## 4. The key idea: cache by scope-signature, not by user

Authorization is group/scope based, so **many users share the exact same visible
set**. All service engineers in the same country group resolve to the same
effective scopes. Canonicalize that scope set into a **scope-signature** (e.g. a
sorted hash of the effective scope ids) and key the page cache on it. Then 300
users in one group collapse to **one** DB query and one cached page. This is what
turns a 600-query burst into a handful of distinct queries. Per-user caching
would waste memory and hit rate; the natural key is the shared scope set.

L0 computes and caches each user's effective scopes (via the inheritance-aware
`authz_effective_scopes()`), including the derived scope-signature. L1 caches the
rendered page under that signature.

## 5. Keyset (cursor) pagination

Do not use `OFFSET`. Use a stable composite cursor:

```sql
WHERE (d.updated_at, d.id) < (:after_updated, :after_id)
ORDER BY d.updated_at DESC, d.id DESC
LIMIT :page
```

O(page size) regardless of matched-set size, and stable while rows change under
concurrent writes. Implemented in `authz_list_devices()`.

## 6. Estimated counts, not exact

Exact `COUNT(*)` of a 100k matched set is the latency killer. Options, in order
of preference:
- UX that does not need a total ("showing 50, load more").
- Approximate count from the planner (`EXPLAIN (FORMAT JSON)` row estimate for
  the same predicate) or from `pg_class.reltuples` scaled by selectivity.
- Exact count only when the matched set is known small.

Cache the (approximate) total alongside the L1 page under the same signature.

## 7. Connection pooling and read routing

- **RDS Proxy** in front of the cluster (see `make_aurora_global.sh` STEP 9).
  The portal connects to the proxy endpoint; hundreds of client connections
  multiplex onto a small backend pool, and the proxy survives Serverless v2
  scaling events.
- Route list (read) traffic to the cluster **reader endpoint** (add a reader
  instance, STEP 8). The writer stays free for rare admin writes. Serverless v2
  scales ACU under the burst.

## 8. Invalidation

| Change | Invalidate |
|---|---|
| Device attribute / site_id / customer_id | L1 pages expire by TTL (30-60 s); rare, tolerable staleness |
| Grant / role / role_privilege edit | L0 for affected users (or all in the group subtree); L1 expires by TTL |
| Group membership change | L0 for that user |
| Scope edit | L0 for users whose grants reference it; L1 by TTL |

Because device attributes and grants change rarely, short TTLs give high hit
rates with negligible staleness. Active invalidation is only needed on the
authz-changing events (L0); L1 can always ride its TTL.

## 9. Why not roaring bitmaps here

Bitmaps accelerate set membership/union - the step that is already fast. They do
not remove sort, count, row fetch, or connection cost. They need a UUID->dense-int
surrogate map and a materialization/invalidation pipeline, and the roaring module
cannot be loaded on managed AWS Valkey. The scope-signature page cache gives the
same herd absorption with plain Valkey strings. Revisit bitmaps only past ~10M
devices or for a high-QPS pure-`check()` edge service that returns no rows.

## 10. Expected outcome

With L1 (scope-signature page cache) the login burst barely reaches the DB. Even
ignoring L1, a keyset page-1 query is single-digit to low-tens of milliseconds;
with RDS Proxy and a reader, a few-hundred-query burst drains in well under a
second. The design holds - the discipline is in pagination, counting, and
pooling, not in the authorization model.

## 10a. Implementation (fleetshell-portal)

Built as a fail-open layer over the existing Valkey client. A broken/absent
Valkey is always a cache MISS -- it never breaks a request, only removes the
speed-up. Toggle the whole thing off with `AUTHZ_CACHE=false` (A/B testing).

- `src/lib/server/cache.ts` -- primitives: `cacheGet/cacheSet/cacheDel`,
  `hashKey`, and the global generation `authzGen()` / `bumpAuthzGen()`.
- `src/lib/server/authz.ts`
  - `resolveGroupIds(userId)` is now L0-cached: key `authz:groups:{userId}`,
    TTL 600s. `invalidateUserGroups(userId)` purges it.
  - `scopeSignature(groupIds, verb[, type])` -- L0 scope-signature: a digest of
    the effective scope-id SET (from `authz_effective_scopes`), keyed
    `authz:sig:{g}:{type}:{verb}:{hash(sortedGroupIds)}`, TTL 600s.
- L1 result pages / counts (keyed by the signature), TTL 45s:
  - devices page load (scope mode): `list:dev:{g}:{sig}:{hash(q)}:{cursor}`.
  - `deviceQuery.countDevices`: `count:dev:{g}:{sig|all}:{hash(q)}`.

**Generation `g`.** One counter `authz:gen` (INCR = logical flush) is embedded in
every signature/page/count key. Grant, role-privilege, and group-delete mutations
call `bumpAuthzGen()`; group-membership add/remove calls `invalidateUserGroups()`
(the groupIds hash then rotates the signature key on its own -- no global flush).
Device attribute edits ride the L1 TTL. `authzGen()` is memoized in-process
for 5s to avoid a GET per request. Invalidation is wired in the admin actions:
`administration/{grants,roles,groups,personas}/+page.server.ts`.

**Runtime tuning (Settings page).** The `enabled` flag + both TTLs are stored in
the Valkey hash `authz:cfg` and edited under **Settings -> Authorization cache**
(admin-only). `cache.ts` reads them via `getCacheConfig()` (memoized 5s). The env
`AUTHZ_CACHE=false` is a hard kill switch that overrides the runtime flag.
**Flush cache now** on the same page calls `bumpAuthzGen()`.

**Timing chip.** The Devices pager shows a muted `list Nms / count Nms` chip; a
`•` after a number means that query was served from cache (L1 hit). The list time
comes from the page load (`data.listMs`/`listCached`); the count time from the
`/devices/count` response (`ms`/`cached`). Use it to confirm cache behaviour and
spot regressions at a glance.

## 11. Validated benchmark (192k devices, ~1M grant rows, Serverless v2 0.5 ACU)

Measured with the real anonymized import. The list query is served by
`authz_fastpath.sql` (pivot scopes -> index nested-loops, UNION by shape).

| Operation | Naive reference fn | Fast path | Notes |
|---|---|---|---|
| List page-1, broadest group (whole fleet, 192k visible) | 173,000 ms | ~390 ms | inherent set-size cost |
| List page-1, BU_MR (~41k visible) | 173,000 ms | ~330 ms | 245 region+product scopes |
| Point check (uncached) | 102 ms | 25 ms | sub-ms once L0-cached in app |

What made the difference, in order of impact:
1. **Index-using query** instead of a per-row `authz_device_in_scope()` filter
   (the planner could not see the predicates through the function): 173 s -> ~1 s.
2. **Group-first scope resolution** - drive from the user's groups then fetch
   their grants, instead of expanding all ~62k system-wide grants first: cut
   ~193k buffers / 105 ms of pure resolution overhead.
3. **Same-shape scope collapse** - all region-only scopes become one
   `region_path <@ ANY(array)` BitmapOr over the GiST index instead of one scan
   per scope (which re-read the device heap ~50x).

The residual cost is proportional to the VISIBLE SET SIZE (you must sort it to
paginate), not to the number of scopes - which is exactly what L1 (scope-
signature page cache) absorbs, since broad users share signatures.

Remaining opt-in levers, only if uncached list latency becomes a UX problem:
- **`work_mem`** on the list path (e.g. 128 MB) removes the sort/dedup temp
  spill seen at 0.5 ACU.
- **Multi-dimension scope collapse** - group `(region=X_i, product=P)` scopes
  that share the same non-region dimensions into one
  `region_path <@ ANY(regions) AND product_path <@ P` scan (real pattern for
  the `BU_*` groups: one product across many regions).
- **Scan-by-`updated_at` for broad users** - for users who can see most of the
  fleet, an index scan on `device(updated_at DESC)` filtering per-row against
  the ~few-hundred pivoted scopes finds page-1 in tens of rows; the opposite
  trade-off to materializing the set (good broad, bad narrow).
