# File Subscriptions — feature + runtime design

Status:
- **Master data + portal UI: BUILT** (`Services > File Subscriptions`).
- **Valkey spool: BUILT** (`spoolValkey` + `src/lib/server/subscriptions.ts` +
  `scripts/spool-subscriptions.mjs`).
- **Subscription-handler fleet (the delivery runtime): NOT built.** This document
  is the design to implement it against. It will be a new top-level **Rust**
  package (like `squid-infoproxy`), deployed as a horizontally-scaled fleet of
  worker containers.

File Subscriptions decide, for a device file that has arrived at the platform,
**which files** (matcher) get delivered **where** (subscriber servers = delivery
targets), and carry that out reliably even when a target is temporarily down.

---

## 1. Master data model (GLOBAL Aurora)

See `infrastructure/sql/migrate_file_subscriptions.sql`.

| Table | Meaning |
|---|---|
| `subscriber_server` | A delivery target: `delivery_method` (adls/s3/scp), connection + `auth` jsonb (secrets PLAINTEXT for now), `root_path` / `use_partno_folder` / `container_path`, `country`, `use_case`, and **`activated`**. |
| `subscription` | A file matcher: optional `modality_id` / `product_id` narrowing (NULL = any), a PCRE `pattern`, and a `negate` exclusion flag. |
| `subscription_server` | N:M attach matrix: one subscription delivers to many servers. |

**`activated` semantics (important).** `activated = false` does **not** mean
"ignore this server". It means the server is not (yet) receiving files -- e.g. it
is newly provisioned, under maintenance, or being repaired. Files that arrive
during that window must still produce **jobs** for the server, so that once it is
reactivated its accumulated backlog is delivered. Therefore the spool includes
deactivated servers (with `activated: false`), and the handler enqueues jobs for
every matching server but only **processes** jobs for activated ones.

---

## 2. Valkey spool (authorization/config plane) — BUILT

The portal spools the resolved subscription config, keyed by device **product**
(mirroring the classification `data_classes:<MODALITY>:<PRODUCT>` convention that
aeroftp already consumes):

```
HASH  ftp_subscriptions:<MODALITY>:<PRODUCT>
      field = subscription name
      value = JSON { pattern, negate, servers: [ <server>, ... ] }
```

`<server>` is the **denormalized** delivery target so a handler needs a single
key lookup:

```json
{
  "id": "<uuid>", "name": "...", "activated": true,
  "delivery_method": "adls|s3|scp",
  "host": "...", "country": "US", "use_case": "compliance|internal",
  "root_path": "...", "use_partno_folder": false, "container_path": "...",
  "auth": { ... method-specific, secrets plaintext ... }
}
```

**Resolution** for product `P` in modality `M`: union of subscriptions that are
`global` (modality+product NULL) + `modality-wide` (modality=M, product NULL) +
`product` (product=P). A subscription with zero attached servers is dropped; a
product with no applicable subscription has its key deleted. Stale keys are
pruned. The spool is authoritative and idempotent; re-run on any master-data
change (the **Save to Valkey** button or `node scripts/spool-subscriptions.mjs`).

---

## 3. Delivery runtime (data plane) — TO BUILD

The runtime is a fan-in / fan-out pipeline over Valkey between **aeroftp** (the
ingest side) and the **subscription-handler fleet** (the delivery side). All key
names below are the proposed layout; confirm/adjust when implementing.

### 3.1 Ingest (aeroftp)

When a file arrives, aeroftp performs all of its own checks (contracts, DTM,
logsanitizer rules) and stores the file in the appropriate staging folder:

- `/dirty` — needs to go through logsanitizer first;
- `/clean` — already fine to forward.

It then publishes the file into Valkey for the handler fleet:

1. Write the file descriptor:
   `HSET ft:incoming:files:<uuid>  { path, product, modality, device, serial, size, sha256, stage(dirty|clean), received_at, ... }`
   (`<uuid>` identifies this ingested file; includes what a handler needs to
   resolve the product key + build a delivery path.)
2. `LPUSH ft:incoming:global <uuid>` — the global work queue (durable backlog).
3. `PUBLISH ft:incoming:events <uuid>` — a wake-up hint for idle handlers.

The list is the source of truth (survives restarts); the pub/sub is only a
latency optimization -- a handler must also drain `ft:incoming:global` on
startup and periodically, never relying on the notification alone.

### 3.2 Claim (handler fleet, competing consumers)

The fleet is N identical handler containers. Each idle handler:

1. Subscribes to `ft:incoming:events`.
2. On a notification (or a poll tick), backs off a **random 0–1000 ms** delay to
   spread the thundering herd across the fleet.
3. `RPOPLPUSH ft:incoming:global  ft:incoming:worker:<handler_id>` — atomically
   claims **one** item into its own in-flight list (reliable-queue pattern:
   the item is never lost if the handler crashes mid-processing; a reaper can
   requeue orphaned `ft:incoming:worker:*` entries).

Because every handler competes on the same `RPOPLPUSH`, each file is claimed by
exactly one handler; the random backoff keeps them from colliding constantly.

### 3.3 Resolve + fan-out to per-server job queues

For the claimed `<uuid>`:

1. Read `ft:incoming:files:<uuid>` -> product/modality (+ filename).
2. `HGETALL ftp_subscriptions:<MODALITY>:<PRODUCT>` -> the applicable
   subscriptions (positive matchers + `negate` exclusions).
3. Evaluate the matchers against the filename to compute the **set of matching
   servers**:
   - a server is selected if at least one positive (`negate=false`) subscription
     attached to it matches, AND
   - no `negate=true` subscription attached to it matches (exclusions carve a
     subset out of an overly-broad positive matcher).
4. For **every** matching server (activated or not):
   `LPUSH ft:jobs:<server_id> <uuid>` — the per-server delivery queue. Jobs are
   created regardless of `activated` so a down server accumulates its backlog.
5. Remove the item from the handler's in-flight list
   (`LREM ft:incoming:worker:<handler_id> 1 <uuid>`).

### 3.4 Deliver (per-server jobs)

The handler then processes delivery jobs, but **only for activated servers**:

- For each server with `activated = true`, drain `ft:jobs:<server_id>` (again via
  a reliable `RPOPLPUSH ft:jobs:<server_id> ft:jobs:<server_id>:inflight:<hid>`)
  and deliver the file over the server's `delivery_method` (ADLS / S3 / SCP)
  using its `auth`, `root_path`, `use_partno_folder`, `container_path`.
- A **deactivated** server's `ft:jobs:<server_id>` list simply grows; nothing
  drains it. When the server is flipped to `activated = true` (portal edit, then
  re-spool), handlers begin draining the accumulated backlog in FIFO order.
- Reference-count / delete `ft:incoming:files:<uuid>` (and the staged file) once
  every selected server's job has been delivered (or hand off to a retention
  policy).

### 3.5 Reliability properties

- **At-least-once**: `RPOPLPUSH` in-flight lists at both the claim and the deliver
  stage mean a crash never drops a file; a reaper requeues stale in-flight items.
- **Backlog survives outages**: per-server `ft:jobs:<server_id>` lists are durable
  and independent of `activated`, so a server repaired after downtime receives
  everything it missed.
- **Horizontal scale**: competing `RPOPLPUSH` consumers + random backoff let the
  fleet scale out without central coordination.

### 3.6 Proposed Valkey keys (summary)

| Key | Type | Written by | Meaning |
|---|---|---|---|
| `ftp_subscriptions:<MOD>:<PROD>` | HASH | portal spool | config: matchers + denormalized targets |
| `ft:incoming:files:<uuid>` | HASH | aeroftp | file descriptor |
| `ft:incoming:global` | LIST | aeroftp | global work queue (durable) |
| `ft:incoming:events` | pub/sub | aeroftp | wake-up hint |
| `ft:incoming:worker:<hid>` | LIST | handler | per-handler in-flight (claim stage) |
| `ft:jobs:<server_id>` | LIST | handler | per-server delivery queue (backlog) |
| `ft:jobs:<server_id>:inflight:<hid>` | LIST | handler | per-server in-flight (deliver stage) |

---

## 4. Implementation notes for the handler package (later)

- New top-level **Rust** package (e.g. `fleetshell-subscriber` / `ft-subscriber`),
  consistent with `squid-infoproxy` and the gateway: `ring`-only rustls, no
  aws_lc_rs. A Valkey client will be needed -- either reuse the minimal blocking
  RESP client from `squid-infoproxy` (extended with `LPUSH`/`RPOPLPUSH`/`HGETALL`/
  pub/sub) or adopt an async client vetted for the ring provider.
- The matcher evaluation (positive + `negate`) is small, pure logic -- factor it
  so it is unit-testable (mirror `squid-infoproxy/src/matcher.rs`).
- Secrets are plaintext in the spooled `auth` today; Secrets-Manager hardening is
  a separate pass (same open item as the gateway PSK and subscriber_server.auth).
