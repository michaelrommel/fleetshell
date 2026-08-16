# Device & Gateway Valkey spool

How the portal (system of record) mirrors device + gateway master data into
Valkey for the two consumers:

- **aeroftp** reads `systems:by-ip:<ip>` at FTP login (device identity + contracts
  + dtm variant), and
- **ipsecnode** reads `fleetipsec:{psk,site,nat}:<public_ip>` to build the IPsec
  tunnels + NAT (see `/home/rommel/software/fleetsuite/ipsecnode`).

The portal-dev app is the source of truth; these keys are a projection of the
Aurora GLOBAL master data.

## Spool model: write-through on save (not bulk)

Unlike the other spoolers (DTM / classification / infoproxy / subscriptions,
which are authoritative full exports), the device/gateway spool is
**incremental, on save**:

- **On device save** (`spoolDeviceOnSave`): rewrite this device's
  `systems:by-ip:<ip>` key; if `ip_address` changed, delete the old key; then
  re-spool the device's IPsec gateway (the device is part of that gateway's
  `fleetipsec:nat` `device_nat[]`). If the device moved between gateways, both
  the old and new gateway are re-spooled.
- **On gateway save** (`spoolGatewayOnSave`): rewrite `fleetipsec:{psk,site,nat}`
  for its `public_ip`; if `public_ip` changed, delete the stale keys.
- **On delete**: drop the device key / gateway keys and re-spool the affected
  gateway.

This keeps Valkey limited to the systems actually touched (the test fleet) rather
than the full 190k-device import. Spool failures are caught + logged (they do not
fail the DB save); a divergence is visible in the server log.

Helpers: `src/lib/server/device_spool.ts`, `src/lib/server/gateway_spool.ts`.
Manual single-target re-spool: `scripts/spool-device.mjs <id|ip>`,
`scripts/spool-gateway.mjs <id|public_ip>`.

**Stale cleanup (open follow-up):** edge deletes cover IP-change / device-delete /
gateway-delete. A periodic reconcile/GC pass (drop keys with no live owner) is
not built yet.

## `systems:by-ip:<device.ip_address>` (HASH) — owned by the portal

The key is the device's routable/global IP (`device.ip_address`) — the source IP
aeroftp sees at login. aeroftp stores every field as opaque S3 object metadata and
keys off `modality`, `product`, `partno`, `serial` (and builds
`data_classes:<modality>:<product>` from the first two).

| field | source |
|---|---|
| `modality` | modality node name = `subltree(product_path, 0, 2)` (level-2; see note) |
| `product` | product node name = the model's direct parent `subpath(product_path, 0, nlevel-1)` |
| `partno` | the device's model `product_model.partno` |
| `serial` | `device.serial` |
| `country` | `device.country_iso` |
| `dtm` | `customer.dtm_variant` via `device.customer_id`, else `STD` |
| `contracts` | built from the device contract flags (below) |

Notes:
- `modality`/`product` use the **same path expressions the device page uses**, so
  they match the strings the classification spool writes into
  `data_classes:<MODALITY>:<PRODUCT>` (otherwise aeroftp's class lookup misses).
- **Product-tree shape (no off-by-one):** the tree has a **root node at position
  0** (legacy RDPRODUCT id `1`), so paths are `root.modality.product.model...`.
  The importer defines modality as `labels[1]` (level 2), so `subltree(path,0,2)`
  targets the modality node exactly, and the model's product is its direct parent
  `subpath(path,0,nlevel-1)`. Do NOT resolve these by `kind='modality'` /
  `kind='product'`: the root is *also* `kind='modality'` (the importer marks depth
  <= 2 as modality), so a kind-based ancestor lookup matches two nodes (root +
  real modality) and is ambiguous.
- (`device.modality` is a denormalized scalar the device save recomputes from the
  path via the same `subltree(path,0,2)`; it is consistent with this `modality`
  but the spool derives its own value from `product_path` directly.)
- The portal fully owns this key: it is rewritten DEL+HSET; empty fields are
  dropped. (The legacy portal only co-wrote an `app_config` field; that field is
  now **gone** — the app config lives in the DB and is read by the portal's
  Connect workflow, not Valkey.)

### `dtm` — the DTM variant

Value is the customer's DTM variant code: **`STD` (Standard)** or **`STR`
(Strict)** — the same code used as the last segment of `dtm:{FROM}:TO:VARIANT`. A
device with no customer (or no variant) falls back to `STD`. Sourced from
`customer.dtm_variant`.

### `contracts` — comma-joined flags

Built from three device fields:
- `device.internal_use` ∈ {`STD` (Standard), `NIU` (No internal use), NULL} —
  mutually exclusive; NULL = neither.
- `device.dpa` — Data Processing Agreement (independent toggle).
- `device.dmy` — Dummy (independent toggle; new — was not modeled in the old
  portal).

Spooled value = the active codes joined with commas, ordered `[STD|NIU]`, `DPA`,
`DMY` — e.g. `STD,DPA`. Edited in the device **Manage** tab (NAT & contracts).

## `fleetipsec:{psk,site,nat}:<gateway.public_ip>` — owned by the portal

One spool unit per gateway (keyed by `public_ip`); the NAT record is built from
the gateway's attached devices, so device saves also trigger a gateway re-spool.
A gateway with no `public_ip` is skipped (nothing to key on).

### `fleetipsec:psk:<ip>` — plain string
`gateway.psk`. Absent PSK → the key is removed.

### `fleetipsec:site:<ip>` — JSON SiteRecord (crypto)
Built from `gateway.ipsec` (authored via `IpsecEditor`):
```json
{ "ike_version": 2, "static_ip": true, "ike_identity": "…", "dyndns_password": "…",
  "ike_enc": ["aes256"], "ike_auth": ["sha256"], "ike_dh": [14],
  "esp_enc": ["aes256gcm"], "esp_auth": ["none"], "esp_pfs": [14],
  "remote_ts": ["10.0.0.0/24"] }
```
Verified against ipsecnode:
- **Crypto fields are ALWAYS arrays.** ipsecnode's `OneOrMany<T>` deserializer
  (`proposals.rs`) accepts arrays natively, so the old single-element "collapse to
  scalar" quirk is dropped.
- **`customer_id` is NOT spooled** — ipsecnode never reads it. (`gateway.name` is
  the human handle, kept in Aurora only.)
- `dyndns_password` is only emitted for dynamic-IP gateways (`static_ip=false`).

### `fleetipsec:nat:<ip>` — JSON NAT record
```json
{ "device_nat": [ { "internal_ip": "10.67.1.5", "global_ip": "198.51.100.5" } ],
  "backend_nat": { "access_server": "10.67.250.250", "sd_server": "…", "em_server": "…" } }
```
- `device_nat[]` = one entry per attached device with an IP. `global_ip =
  device.ip_address`; `internal_ip` depends on **`device.nat_mode`**:
  - `customer` (default): customer already NATs → `internal_ip = global_ip`
    (identity; VPP mapping is a no-op but the /32 route is still advertised).
  - `platform`: we NAT → `internal_ip = device.ip_real` (falls back to
    `ip_address` if `ip_real` is empty).
  `internal_ip` is the real SNAT/DNAT source in ipsecnode (`vpp.rs`) and is
  required — never null.
- `backend_nat` = the three customer-view IPs from
  `gateway.backend_access_ip` / `backend_sd_ip` / `backend_em_ip`
  (`access_server` / `sd_server` / `em_server`). The real IPs live in
  `ipsecnode.toml`, not Valkey. **Omitted entirely when none is set** — ipsecnode
  treats `backend_nat` as an optional record (`#[serde(default)] Option<…>`,
  guarded by `if let Some` / `if pairs.is_empty()`), so absence installs no
  backend DNAT roles. Edited in the gateway detail editor (Backend NAT).

## Tunnel Gateway (Connect) moved device → gateway

The Connect JWT `gateway` claim (the regional fleetshell-gateway LB address a
fleetshell-client dials) is **one value per AWS deployment region**, not per
device. It moved off `device.tunnel_gateway` to **`gateway.tunnel_gateway`**. The
Connect workflow (`/api/tunnel/sign`) resolves it via the device's IPsec gateway:
`device → device.gateway_id → gateway.tunnel_gateway`. This is portal-internal
(read from the DB) and does **not** appear in any Valkey key. For now it is a
plain per-gateway field (may later be hoisted to a region-level default).

## Schema

`infrastructure/sql/migrate_device_gateway_spool.sql` (folded into
`schema_global.sql`, in `reload.sh`):
- `device.nat_mode` (`customer`|`platform`, default `customer`)
- `device.internal_use` (`STD`|`NIU`|NULL), `device.dpa`, `device.dmy`
- `gateway.tunnel_gateway`, `gateway.backend_access_ip` / `backend_sd_ip` /
  `backend_em_ip`
- drops `device.tunnel_gateway`
