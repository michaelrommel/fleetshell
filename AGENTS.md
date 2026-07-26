# FleetShell — Architecture & Agent Handoff Document

This document is the single source of truth for agents working on FleetShell.
It describes the repository layout, what each component currently does, all
wire protocols, and the open work items per component.

The project is worked on via **git worktrees** — one worktree per component.
Each section below is self-contained so an agent can read only their section
and have enough context to proceed.

---

## Table of contents

1. [Repository layout](#1-repository-layout)
2. [System overview](#2-system-overview)
3. [Component: fleetshell-portal](#3-component-fleetshell-portal)
4. [Component: fleetshell-client](#4-component-fleetshell-client)
5. [Component: fleetshell-gateway](#5-component-fleetshell-gateway)
6. [Cross-cutting concerns](#6-cross-cutting-concerns)
7. [Open work items](#7-open-work-items)

---

## 1. Repository layout

```
fleetshell/
├── Cargo.toml                  # Cargo workspace (resolver = "2")
│                               # members: fleetshell-client/src-tauri, fleetshell-gateway
├── Cargo.lock
├── AGENTS.md                   # ← this file
├── TODO.md                     # Detailed task tracking
├── .cargo/config.toml          # Cross-compile target: x86_64-pc-windows-gnu (MinGW posix-threads)
├── scripts/
│   └── build-windows-x64.sh   # Cross-compile helper; --installer flag triggers NSIS packaging
│
├── fleetshell-portal/          # SvelteKit web portal (Node.js / TypeScript)
│   ├── package.json
│   ├── svelte.config.js
│   ├── src/
│   │   ├── hooks.server.ts     # Session auth guard (redirects to /login)
│   │   ├── lib/
│   │   │   ├── components/
│   │   │   │   └── AppShell.svelte     # Sidebar + page wrapper
│   │   │   └── server/
│   │   │       ├── constants.ts        # ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET
│   │   │       ├── jwt.ts              # issueProbeToken / verifyProbeToken / issueTunnelToken
│   │   │       ├── redis.ts            # Singleton Redis client (ioredis)
│   │   │       └── session.ts          # Cookie-based session helpers
│   │   └── routes/
│   │       ├── login/                  # Static username/password login
│   │       ├── logout/                 # Cookie clear + redirect
│   │       ├── welcome/                # First-run page → directs user to Support then Devices
│   │       ├── (app)/                  # Auth-guarded app shell
│   │       │   ├── devices/            # IP-based device lookup + Connect form
│   │       │   ├── support/            # Client download + fleetshell:// enrollment link
│   │       │   ├── settings/           # (placeholder)
│   │       │   └── administration/     # (placeholder)
│   │       └── api/
│   │           ├── client/probe/[id]/      # POST — receives probe from client, stores in Redis
│   │           ├── clients/                # POST — get/create stable client ID, issue probe JWT
│   │           ├── probes/[id]/stream/     # GET (SSE) — streams probe result to browser
│   │           ├── enrollment/[id]/stream/ # GET (SSE) — streams full enrollment events to browser
│   │           ├── tunnel/sign/            # POST — sign a tunnel JWT server-side (JWT_SECRET never leaves)
│   │           └── cert/
│   │               ├── request/            # POST — accept CSR, store static cert chain, publish cert-ready
│   │               ├── status/             # GET  — poll cert issuance status (none|pending|ready)
│   │               ├── get/                # GET  — fetch the issued certificate chain (PEM)
│   │               ├── key/                # GET  — fetch the shared private key (PEM)
│   │               └── confirm/            # POST — client confirms receipt; marks enrollment done
│   ├── certs/
│   │   └── client.pem                  # (deprecated) cert chain formerly read from disk;
│   │                                   #   now injected via CLIENT_CERT env var
│   ├── private/
│   │   └── client.key                  # (deprecated) private key formerly read from disk;
│   │                                   #   now injected via CLIENT_KEY env var
│   └── support/apps/[filename]/        # GET  — serves client installer download
│
├── fleetshell-client/          # Tauri 2 desktop application (Windows target)
│   ├── src/                    # SvelteKit + Svelte 5 frontend
│   │   ├── app.css             # Gruvbox-inspired design tokens (CSS custom properties)
│   │   └── routes/
│   │       ├── +layout.svelte  # Font-size loader from config
│   │       └── +page.svelte    # Tab bar: Functions | Settings | Logging | Enrollment
│   └── src-tauri/              # Rust/Tauri backend
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs          # Tauri setup, single-instance forwarding, registered commands
│           ├── main.rs         # Binary entry point (calls lib::run)
│           ├── server.rs       # Axum router on 127.0.0.1:8080; TLS acceptor; tunnel + deep-link handlers
│           ├── tunnel.rs       # Port-spec parser, slot-based TCP listeners, TLS gateway sessions
│           ├── slot.rs         # SlotManager: 16 loopback slots (127.0.0.2–17), idle monitor
│           ├── portal.rs       # Deep-link decoder/dispatcher, enrollment orchestrator
│           ├── config.rs       # AppConfig struct (TOML), cert/key persistence helpers
│           └── util.rs         # navigate(), show_window() helpers
│
└── fleetshell-gateway/         # Standalone Rust TCP/TLS tunnel gateway
    ├── Cargo.toml
    └── src/
        ├── main.rs             # Tokio accept loop, TLS handshake, spawns handler tasks
        ├── config.rs           # Config::from_env() — all settings via env vars
        ├── auth.rs             # JWT verify_connection(), Claims struct, AuthError
        ├── handler.rs          # Per-connection logic: parse → auth → connect → proxy; SNI support
        ├── health.rs           # HTTP health-check server on GATEWAY_HEALTH_ADDR (:8080)
        ├── tls.rs              # build_acceptor(): self-signed (rcgen) or file-based PEM
        └── transform.rs       # HTTP/1.1 transform proxy + TransformHook trait + NoopHook
```

---

## 2. System overview

```
  Portal (web, AWS)          Client (Windows desktop)         Gateway (AWS, TCP/TLS)
  ─────────────────          ────────────────────────         ──────────────────────
  SvelteKit + Node.js        Tauri 2 + SvelteKit              Rust + tokio-rustls

  Login / device mgmt        Tray app                         TLS listener :8443
  JWT issuance               Local API :8080 (HTTP or HTTPS)  JWT verification
  Probe initiation  ──SSE──► Probe via deep-link              Bidirectional TCP proxy
  Connect form ─────────────► POST /api/tunnel ───────────────► TCP → target:port
```

### Full tunnel sequence

```
  Browser / portal     fleetshell-client (:8080)     fleetshell-gateway (:443)     Target device
       |                        |                              |                         |
       |─POST /api/tunnel/sign─►| (stays on portal server)    |                         |
       |◄─{ token }─────────────|                              |                         |
       |                        |                              |                         |
       |─POST /api/tunnel──────►| (to 127-0-0-1.client.fleetshell.com:8080)             |
       |                        |─bind TcpListener(slot_ip:P)  |                         |
       |◄─200 { ports, urls }───|                              |                         |
       |                        |                              |                         |
  Local app ──TCP:slot_ip:P─────►|                              |                         |
                                 |─TCP/TLS connect─────────────►|                         |
                                 |─JSON handshake + \n─────────►|                         |
                                 |                              |─verify JWT              |
                                 |◄─"200 CONNECTED\n"───────────|                         |
                                 |                              |─TCP connect────────────►|
                                 |◄══════raw bytes (copy_bidirectional)══════════════════►|
```

### Deep-link / probe sequence (enrollment)

```
  Portal (browser)           fleetshell-client               Portal (API)
       |                            |                              |
       |─opens fleetshell://───────►|                              |
       |  base64url({type:enroll,   |─POST /api/client/probe/─────►|
       |    payload:id, token:jwt}) |   {version, arch}            |
       |                            |◄─200 OK──────────────────────|
       |◄─SSE probe result──────────────────────────────────────────|
       |                            |─POST /api/cert/request───────►|
       |                            |─poll /api/cert/status─────────|
       |                            |─GET /api/cert/get─────────────|
       |                            |─GET /api/cert/key─────────────|
       |                            |─POST /api/cert/confirm────────|
       |◄─SSE enrollment-confirmed──────────────────────────────────|
```

---

## 3. Component: fleetshell-portal

### Tech stack

| Layer | Technology |
|---|---|
| Framework | SvelteKit 2 (SSR, `@sveltejs/adapter-node`) |
| Language | TypeScript 6 / Svelte 5 |
| Runtime | Node.js |
| Database | Redis 6 (via `redis` npm package) |
| Auth | Cookie session (signed) + static credentials from env |
| JWT | Custom HS256 implementation (Node.js `crypto` module, no external lib) |
| Styling | Custom CSS (Gruvbox palette, CSS custom properties) |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ADMIN_USERNAME` | — | Portal login username |
| `ADMIN_PASSWORD` | — | Portal login password |
| `SESSION_SECRET` | — | Cookie signing key |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_SECRET` | `change-me-in-production` | HMAC secret for signing tunnel + probe JWTs |
| `CLIENT_CERT` | — | PEM certificate chain for the wildcard cert — injected from AWS Secrets Manager via `valueFrom` in the ECS task definition; replaces the former `certs/client.pem` file |
| `CLIENT_KEY` | — | PEM private key matching the cert — injected from AWS Secrets Manager via `valueFrom`; replaces the former `private/client.key` file |

### What is implemented

- **Static login** — username/password form, signed session cookie, auth guard in
  `hooks.server.ts` redirects all `(app)` routes to `/login`.
- **JWT helpers** — `lib/server/jwt.ts` exports:
  - `issueProbeToken(probeId, secret)` — 5-minute probe JWT
  - `verifyProbeToken(token, probeId, secret)` → `'ok' | 'expired' | 'invalid'`
  - `issueTunnelToken(sub, target, ports, gw, secret, ttlSeconds?)` — 24-hour tunnel JWT
  All use Node.js native `crypto` (HMAC-SHA256) with timing-safe comparison.
- **Redis persistence** — `lib/server/redis.ts` provides a singleton client.
  Client IDs are stored as Redis hashes under `clients:<id>`.
  Device records are stored under `systems:by-ip:<ip>`.
- **Enrollment flow** — the full guided sequence is orchestrated from the `/support`
  page and uses the following API endpoints in order:
  1. `POST /api/clients` — browser fetches/creates the stable client UUID and a
     short-lived probe JWT; resets the probe slot in Redis.
  2. `/support` page generates a `fleetshell://` deep-link with a base64url-encoded
     JSON envelope `{type:"enroll", payload:"<id>", token:"<jwt>"}` and opens it.
  3. `POST /api/client/probe/[id]` — client posts `{version, arch}` with Bearer
     JWT; portal validates, stores result, publishes to the `probe:` Redis channel.
  4. `GET /api/probes/[id]/stream` — browser SSE stream receives the probe result.
  5. `POST /api/cert/request` — client posts `{id, csr}` with Bearer JWT; portal
     validates, stores the CSR, marks cert `pending`, and after a simulated CA
     delay stores the **static** cert chain from `certs/client.pem` and marks cert
     `ready`.  Publishes `csr-received` and `cert-ready` on the `enrollment:` channel.
  6. `GET /api/cert/status?id=` — client polls every 3 s (120 s timeout) until `"ready"`.
  7. `GET /api/cert/get?id=` — client fetches the certificate chain (PEM).
  8. `GET /api/cert/key?id=` — client fetches the matching private key (PEM);
     requires cert status `ready`; key is read from `private/client.key` at startup.
  9. `POST /api/cert/confirm` — client confirms receipt; portal publishes
     `enrollment-confirmed` so the browser SSE stream advances to the final step.
  - `GET /api/enrollment/[id]/stream` — browser SSE stream for steps 5–9;
    receives `csr-received`, `cert-ready`, and `enrollment-confirmed` events.
- **Static certificate (Phase 1)** — all enrolled clients receive the same shared
  wildcard certificate (`*.client.fleetshell.com`).  The cert chain and private key
  are loaded from the `CLIENT_CERT` and `CLIENT_KEY` environment variables,
  which are injected at container start from **AWS Secrets Manager** (using
  `valueFrom` in the ECS task definition — **not** `value`, which would inject
  the ARN string literally).  The former `certs/client.pem` / `private/client.key`
  filesystem approach is deprecated and no longer used.
  Phase 2 will replace this with per-client key pairs and real CSRs.
- **Device lookup + Connect form** — `/devices` page searches Redis by IP address
  and renders the raw key/value hash.  The page also has a Connect form with fields:
  `target`, `application` (http/https/rdp/vnc/ssh/expert-i), `ports`, `gateway`,
  `servicekey`, `username`, `password`, `width`, `height`, `dpi`.
  Per port-row settings:
  - **Guac** checkbox — route RDP/VNC/SSH through guacd (browser session instead of native app)
  - **E2E** checkbox — relay raw TLS bytes end-to-end (mutually exclusive with guac)
  - **Open** checkbox — show an Open button in the result box
  - **Path sub-row** (http/https/expert-i rows) — URL path suffix appended when
    opening a browser tab (e.g. `/adminportal`); SNI field also lives here
  - **Guac sub-row** (rdp/vnc/ssh rows with guac checked) — Width/Height/DPI and a
    **Drives** checkbox (RDP only) that enables guacd drive sharing via EFS
  The main port-row grid has 6 columns: Ports | Application | Guac | E2E | Open | ✕
  (SNI was removed from the main row and moved into the path sub-row).
  On submit it:
  1. POSTs `{ target, ports, gateway }` to `POST /api/tunnel/sign` to get a JWT
     (JWT_SECRET never leaves the server).
  2. POSTs the full tunnel request (including the JWT) to the local client's API
     at `https://127-0-0-1.client.fleetshell.com:8080/api/tunnel`.
- **Tunnel JWT signing** — `POST /api/tunnel/sign` (auth-guarded) accepts
  `{ target, ports, gateway }`, calls `issueTunnelToken`, and returns `{ token }`.
  The signed JWT is forwarded verbatim to the client API and then to the gateway.
- **Client installer** — `/support` page serves the installer via
  `GET /support/apps/[filename]` (streamed from the filesystem).

### What is NOT yet implemented (open work)

See [§7 Open work items — Portal](#portal-1).

---

## 4. Component: fleetshell-client

### Tech stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri 2 |
| Frontend | SvelteKit 2 + Svelte 5 (TypeScript) |
| Backend | Rust (edition 2021, MSRV 1.77.2) |
| Target platform | Windows x64 (cross-compiled from Linux via MinGW) |
| Async runtime | tokio 1 (full features) |
| Local API | axum 0.8 on `127.0.0.1:8080` (HTTP or HTTPS depending on enrollment state) |
| TLS (outbound) | tokio-rustls 0.26 + rustls-native-certs (OS trust store) |
| TLS (inbound API) | tokio-rustls 0.26 + rustls (ring provider) — loaded from persisted cert/key |
| HTTP client | reqwest 0.12 (rustls-tls-native-roots) |
| Logging | tauri-plugin-log |

**Current version: 0.4.0** — always kept in sync between `src-tauri/Cargo.toml`
(`version`) and `src-tauri/tauri.conf.json` (`version`).

### Tauri commands (exposed to frontend)

| Command | Description |
|---|---|
| `get_config` | Load `AppConfig` from TOML file |
| `save_config` | Persist `AppConfig` to TOML file |
| `get_log_history` | Return last N log lines |
| `enrollment_login` | POST credentials to `{portal_base_url}/api/login`, return raw response |

### AppConfig (persisted as TOML)

```toml
# Location: %APPDATA%\com.fleetshell.client\config\config.toml (Windows)
font_size       = 15          # UI font size in px
vnc_viewer      = ""          # Full path to TigerVNC viewer; empty = search PATH
portal_base_url = "https://portal.fleetshell.com"
idle_timeout    = 300         # Idle seconds before a slot is released (10–3600; default 300)
client_id       = "..."       # UUID set after first successful enrollment; absent until then
```

### Certificate / key storage (alongside config.toml)

| Path | Content |
|---|---|
| `<id>.pem` | PEM cert chain issued by the portal (wildcard `*.client.fleetshell.com`) |
| `<id>.key` | PEM private key matching the cert |
| `<id>.csr` | CSR (placeholder string in Phase 1; real PKCS#10 in Phase 2) |
| `archive/<id>_<ts>.<ext>` | Previous identity files rotated on re-enrollment |

`config.rs` exposes: `save_cert`, `load_cert`, `save_key`, `load_key`, `has_key`,
`archive_identity`, `csr_path`.

### Local API server

The server always binds to `127.0.0.1:8080`.  The public hostname used for TLS
SNI and deep-link forwarding is `127-0-0-1.client.fleetshell.com` (covered by the
`*.client.fleetshell.com` wildcard cert).

At startup, `lib.rs` checks whether `client_id` is set in the config and whether
the matching `.pem` / `.key` files exist.  If both are present, `build_tls_acceptor`
creates a `tokio_rustls::TlsAcceptor` and the server runs **HTTPS** via `serve_tls`.
Otherwise the server runs **plain HTTP**.

> ⚠️ The TLS mode is chosen once at startup.  After a successful enrollment the
> cert and key are written to disk, but the currently-running server does **not**
> restart.  The HTTPS upgrade only takes effect after the application is restarted.
> See [§7 Open work items — Client](#client-1) for the bug this creates.

#### `POST /api/tunnel`

Accepts JSON, claims a free connection slot, binds local TCP listeners on the
slot's loopback IP, launches local applications, spawns tunnel tasks.  Returns
immediately once all ports are bound.

Request:
```json
{
    "target":      "192.168.13.133",
    "application": "https",
    "ports":       "443,3000-3020",
    "token":       "<jwt>",
    "servicekey":  "abcde-...",
    "gateway":     "atlanta-01",
    "sni":         "device.example.com",
    "e2ecrypt":    false
}
```

Response (200 OK):
```json
{ "status": "connected", "ports": [443, 3000, 3001], "urls": ["https://127-0-0-2.client.fleetshell.com:443"] }
```

Error responses:
- `409 Conflict` — failed to bind a port on the slot IP
- `503 Service Unavailable` — all 16 connection slots are in use
- `500` — other errors

| Field | Notes |
|---|---|
| `target` | Final destination host on the gateway's side |
| `application` | `"http"` \| `"https"` \| `"rdp"` \| `"vnc"` \| `"ssh"` \| `"expert-i"` |
| `ports` | Comma-separated ports/ranges: `"443"`, `"3000-3020"`, `"443,3000-3020"` |
| `token` | JWT forwarded verbatim to the gateway handshake |
| `servicekey` | Optional — triggers Functions tab + navigate event when present |
| `gateway` | `"host"` or `"host:port"` — port defaults to 443 |
| `sni` | Optional (per row) — SNI hostname for TLS + `Host:` header in transform mode |
| `path` | Optional (per row) — URL path suffix appended for http/https/expert-i tabs (e.g. `"/adminportal"`) |
| `enable_drive` | Optional bool — request guacd RDP drive sharing via EFS; gateway uses `GUACD_DRIVE_PATH` |
| `e2ecrypt` | Optional bool (per row) — when `true`, relay raw bytes end-to-end; default `false` = proxy mode |

#### `POST /api/deep-link`

Receives a `fleetshell://` URL forwarded from a second client instance.
Dispatches into the normal deep-link handler.

```json
{ "url": "fleetshell://..." }
```

### Connection slots (`slot.rs`)

`SlotManager` manages 16 independent connection slots backed by loopback addresses:

| Slot | Loopback IP | DNS hostname |
|---|---|---|
| 0 | `127.0.0.2` | `127-0-0-2.client.fleetshell.com` |
| 1 | `127.0.0.3` | `127-0-0-3.client.fleetshell.com` |
| … | … | … |
| 15 | `127.0.0.17` | `127-0-0-17.client.fleetshell.com` |

All DNS hostnames are covered by the `*.client.fleetshell.com` wildcard cert.

`SlotManager::claim()` returns a `SlotHandle` with the slot's index and IP.
`SlotManager::release(idx)` aborts all connection tasks for that slot.

Each slot has an idle monitor (`run_idle_monitor`) that emits `"slot-update"` Tauri
events every second and releases the slot after `idle_timeout` consecutive idle
seconds.  The frontend (`FunctionsView.svelte`) renders all 16 slots as SVG arc
indicators with `free`, `active`, `countdown`, and `idle` states.

### Per-application behaviour

| `application` | Bind IP | Local action | URLs returned |
|---|---|---|---|
| `"http"` | `slot.ip` | none | `http://{slot-dns-host}:{port}{path}` |
| `"https"` | `slot.ip` | none | `https://{slot-dns-host}:{port}{path}` |
| `"expert-i"` | `slot.ip` | none | `https://{slot-dns-host}:{port}{path}` |
| `"rdp"` | `slot.ip` | writes `%TEMP%\fleetshell_rdp_{port}.rdp`, launches `mstsc.exe` | none |
| `"vnc"` | `slot.ip` | writes `%TEMP%\fleetshell_vnc_{port}.vnc`, tries `tvnviewer.exe` / `vncviewer64.exe` / `vncviewer.exe` | none |

For **guac rows** (guac checkbox ticked), the client binds a WebSocket listener on
the slot IP instead of a raw TCP port and returns a `wss://` URL.  The browser
connects via `guacamole-common-js`; the client proxies it to the gateway which
runs the guacd opening handshake.  The response `bind_ip` is populated for both
guac and regular rows so the portal banner shows the slot address in all cases.

`get_tunnel_url` in `tunnel.rs` accepts a `path` argument and appends it when
non-empty and not `"/"`.  Leading `/` is ensured; the empty / `"/"` case produces
a clean `host:port` URL with no trailing slash.

The DNS hostname (`127-x-x-x.client.fleetshell.com`) is returned in URLs instead
of the bare IP so that HTTPS certificates validate correctly.

### Tunnel lifecycle (one per port, per accepted connection)

1. `SlotManager::claim()` — assigns a free slot (loopback IP).
2. `TcpListener::bind(slot_ip:P)` — must succeed for all ports before any task starts.
3. Accept loop spawns a task per inbound connection.
4. Each task:
   a. Connects TCP/TLS to `{gateway_host}:{gateway_port}` (TLS with OS trust store).
   b. Sends the **gateway handshake payload** (JSON + `\n`).
   c. Reads one response line.
   d. On `200 CONNECTED` → `copy_tracked(client_socket, gateway_socket)` (updates
      `last_active` timestamp whenever data flows — used by idle monitor).
   e. On any other response or error → log + emit `navigate { tab: "logging" }`.
5. Idle monitor fires every second; releases the slot after `idle_timeout` idle seconds
   and emits a final `"free"` slot-update event.

### Gateway handshake payload (client → gateway)

```json
{
    "target":       "192.168.13.133",
    "application":  "https",
    "port":         443,
    "token":        "<jwt>",
    "servicekey":   "abcde-...",
    "gateway":      "atlanta-01",
    "sni":          "device.example.com",
    "path":         "/service/tunnel/",
    "e2ecrypt":     false,
    "guac":         false,
    "username":     "Administrator",
    "password":     "<vnc-or-rdp-password>",
    "width":        1920,
    "height":       1080,
    "dpi":          96,
    "enable_drive": false,
    "connection_id": null
}
```

`port` is always a single integer (expanded from the range).
`path` defaults to `"/service/tunnel/"`.
`sni` is forwarded to the gateway for use in proxy-mode TLS + Host header.
`guac`, `username`, `password`, `width`, `height`, `dpi`, `enable_drive` are only
meaningful when `guac: true`; `connection_id` carries a guacd session ID on
WebSocket reconnects (see guacd reconnect section in gateway docs).

### Deep-link handling (`fleetshell://`)

The URL host is a base64url (no padding) JSON envelope:

```json
{ "type": "enroll", "payload": "<id>", "token": "<jwt>" }
```

The client decodes it on startup (via `app.deep_link().get_current()`) or via
`on_open_url` for post-startup events, and via `POST /api/deep-link` when a second
instance forwards it.  Dispatches on `type`; currently `"enroll"` is the only
handled type.

#### Single-instance forwarding

On launch, if argv[1] is a `fleetshell://` URL:
1. Check if port 8080 is listening (300 ms TCP probe).
2. Try `POST https://127-0-0-1.client.fleetshell.com:8080/api/deep-link`.
3. If HTTPS fails (TLS/connection error), try `POST http://127.0.0.1:8080/api/deep-link`.
4. If either succeeds → exit (running instance handled it).
5. If port 8080 is not reachable → continue normal startup (we are the first instance).

#### Enrollment orchestrator (`handle_enroll`)

| Step | Label | Action |
|---|---|---|
| 1 | `[1/7]` | Archive old identity files; persist `client_id` into `AppConfig` |
| 2 | `[2/7]` | `POST {portal_base_url}/api/client/probe/{id}` — `{version, arch}` + Bearer token |
| 3 | `[3/7]` | `POST {portal_base_url}/api/cert/request` — `{id, csr: "placeholder"}` + Bearer token |
| 4+5 | `[4+5/7]` | Poll `GET .../api/cert/status?id=` every 3 s (120 s timeout); then `GET .../api/cert/get?id=`; persist cert as `<id>.pem` |
| 6 | `[6/7]` | `GET .../api/cert/key?id=` (with Bearer token) if key not already on disk; persist as `<id>.key` |
| 7 | `[7/7]` | `POST .../api/cert/confirm` — `{id}` (no Bearer required) |

The portal currently serves a **static shared certificate** (`certs/client.pem`) and
private key (`private/client.key`) to every enrolled client — Phase 1 bootstrapping
using a wildcard cert (`*.client.fleetshell.com`).  The CSR in step 3 is a placeholder
string; a real PKCS#10 PEM will replace it in Phase 2.

### UI tabs and Tauri events

| Tab | Component | Purpose |
|---|---|---|
| `functions` | `FunctionsView` | 16-slot grid (SVG arc indicators) + service key clipboard |
| `settings` | `SettingsView` | Font size, VNC viewer path, portal URL, idle timeout |
| `logging` | `LogView` | Live log stream |
| `enrollment` | inline in `+page.svelte` | Portal URL, username/password, Enroll button |

Backend emits events to switch tabs or update slot state:

| Event | Payload | Trigger |
|---|---|---|
| `"navigate"` | `{ tab: "functions", servicekey: "..." }` | `servicekey` present in `/api/tunnel` request |
| `"navigate"` | `{ tab: "logging" }` | Any tunnel or bind error; deep-link success or error |
| `"slot-update"` | `{ idx, status, progress }` | Every second from idle monitor; also on slot claim |

`status` values: `"active"` (traffic in last 1 s), `"countdown"` (idle, timer running),
`"free"` (slot released).  `progress` is `0.0..1.0` (1 = full ring, used for countdown arc).

### Build / packaging

```bash
# Cross-compile Windows x64 binary (no installer):
./scripts/build-windows-x64.sh

# Cross-compile + build NSIS installer:
./scripts/build-windows-x64.sh --installer
```

Installer type: NSIS, **user-level install** (no admin rights required).

> ⚠️ **Version bump checklist** — Tauri does NOT auto-sync versions between its
> two config files.  Whenever the version number changes, **both** files must be
> updated manually or the installer and the in-process `env!("CARGO_PKG_VERSION")`
> will disagree:
>
> | File | Key |
> |---|---|
> | `src-tauri/Cargo.toml` | `version = "x.y.z"` (line 3) |
> | `src-tauri/tauri.conf.json` | `"version": "x.y.z"` (line 4) |
>
> `Cargo.toml` controls what `env!("CARGO_PKG_VERSION")` returns at compile time
> (used in the probe body sent to the portal).  `tauri.conf.json` controls the
> NSIS installer product version, the window title, and all bundle metadata.
> Changing only one of them produces a binary that reports a different version
> than the installer that shipped it.

### What is NOT yet implemented (open work)

See [§7 Open work items — Client](#client-1).

The portal issues JWTs. The gateway verifies them with `JWT_SECRET` (HS256).

## 5. Component: fleetshell-gateway

### Tech stack

| Layer | Technology |
|---|---|
| Language | Rust (edition 2021) |
| Async runtime | tokio 1 (full) |
| TLS server | tokio-rustls 0.26 + rustls 0.23 (ring backend) |
| Self-signed cert | rcgen 0.14 |
| JWT | jsonwebtoken 10 (rust_crypto / pure-Rust HMAC-SHA256) |
| HTTP parsing | httparse 1 (transform mode only) |
| Serialisation | serde + serde_json |
| Logging | tracing + tracing-subscriber |
| Errors | thiserror |
| Build target | `x86_64-unknown-linux-musl` (static binary) |

### Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_LISTEN_ADDR` | `0.0.0.0:8443` | TCP listen address |
| `JWT_SECRET` | `change-me-in-production` | HMAC-SHA256 secret — **always override** |
| `TLS_CERT_FILE` | *(none)* | PEM cert chain; used only when `GATEWAY_TLS=true` |
| `TLS_KEY_FILE` | *(none)* | PEM private key (PKCS#8 or SEC1); used only when `GATEWAY_TLS=true` |
| `GATEWAY_TLS` | `false` | Set `true` for standalone/dev mode (no NLB in front); gateway terminates TLS itself |
| `GATEWAY_HEALTH_ADDR` | `0.0.0.0:8080` | HTTP health-check listener — point NLB health checks at HTTP on this port to avoid polluting tunnel logs |
| `GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS` | `true` | Skip upstream cert verification in transform mode |
| `GUACD_ADDR` | `127.0.0.1:4822` | Address of the guacd daemon co-located in the same container |
| `GUACD_DRIVE_PATH` | *(none)* | Root directory on the gateway host for RDP drive sharing.  When set, RDP guac sessions with `enable_drive: true` mount a per-device sub-directory (`<path>/<target_ip>/`) as a virtual Windows drive.  Must be writable by UID 1000 (guacd user).  In production this is the EFS mount at `/guac-drives`. |
| `RUST_LOG` | `info` | Log filter — `debug` for per-connection detail, `trace` for TLS internals |

### Wire protocol

**Step 1 — Client sends handshake (newline-terminated JSON):**

```json
{"target":"192.168.13.133","application":"https","port":443,
 "token":"<jwt>","servicekey":"...","gateway":"atlanta-01",
 "sni":"device.example.com","path":"/service/tunnel/","transform":false}
```

**Step 2 — Gateway responds with a single status line:**

| Response | Meaning |
|---|---|
| `200 CONNECTED\n` | JWT valid, target reachable — enter proxy mode |
| `400 BAD REQUEST\n` | Unparseable JSON |
| `401 UNAUTHORIZED\n` | Invalid or expired JWT |
| `403 FORBIDDEN\n` | JWT valid but target/port/gateway not covered by claims |
| `502 BAD GATEWAY\n` | Could not connect to target |

**Step 3 — After `200 CONNECTED` the connection is a raw byte pipe.**
No further framing — `copy_bidirectional` on both sides.

### JWT claims structure

The portal issues JWTs. The gateway verifies them with `JWT_SECRET` (HS256).

```json
{
  "sub":    "alice",
  "iat":    1784325058,
  "exp":    1784411458,
  "target": "192.168.13.187",
  "ports":  "443,3000-3020",
  "gw":     "atlanta-01"
}
```

| Claim | Required | Description |
|---|---|---|
| `target` | yes | Exact host the token authorises; must match `target` in handshake |
| `ports` | yes | Port spec (same comma/range format as client); must include the requested port |
| `gw` | no | If present, `gateway` in handshake must match; prevents cross-gateway token reuse |

### Source module responsibilities

| File | Responsibility |
|---|---|
| `main.rs` | tokio accept loop; TCP-level `info!` log before spawning; optional TLS handshake with debug logs; spawns handler + health tasks |
| `config.rs` | `Config::from_env()` — includes `GATEWAY_TLS`, `GATEWAY_HEALTH_ADDR`, `GUACD_ADDR`, `GUACD_DRIVE_PATH` |
| `auth.rs` | `verify_connection()` — JWT decode + target/port/gateway claims check; has unit tests for `port_in_spec` |
| `handler.rs` | Reads handshake, calls auth, selects proxy mode (raw TCP / transform / guacd); creates per-device drive directory; raw handshake bytes logged at DEBUG; password length logged (value never logged); TCP health probe close demoted to DEBUG |
| `health.rs` | HTTP health-check server on `GATEWAY_HEALTH_ADDR`; responds `200 {"status":"ok"}` to any request; probes logged at DEBUG only |
| `tls.rs` | `build_acceptor()` — loads PEM files or generates self-signed cert via rcgen |
| `transform.rs` | HTTP/1.1 aware proxy loop; `TransformHook` trait; `NoopHook` impl; `SkipServerVerification` for self-signed upstream certs |
| `guac/mod.rs` | Re-exports `connection::{ConnectionParams, RdpParams, VncParams, SshParams}` and `connect()` |
| `guac/connection.rs` | guacd opening handshake (select → args → size/audio/video/image → connect → ready); `ConnectionParams` enum; `to_value_map()` per protocol including drive-sharing params for RDP |
| `guac/protocol.rs` | `Instruction` encode/decode; `write_instruction` / `read_instruction` async I/O helpers |

### Transform mode

When `e2ecrypt: false` (the default) is set in the handshake, the gateway switches to an
HTTP/1.1 request-response loop instead of raw `copy_bidirectional`.

```
client ──HTTP req──► read_header_block + read_body
                     ↓ hook.on_request(message)
upstream ◄────────── write request
upstream ──HTTP resp─► read_header_block + read_body
                        ↓ hook.on_response(message)
client ◄────────────── write response
```

The `TransformHook` trait:

```rust
pub trait TransformHook: Send + Sync {
    fn on_request (&self, msg: &mut HttpMessage) -> HookDecision;
    fn on_response(&self, msg: &mut HttpMessage) -> HookDecision;
}
```

`HttpMessage` carries parsed headers (`Vec<(String, String)>`) and a body
(`Vec<u8>`). The hook may freely edit both. If it modifies `body` it must also
update `Content-Length`.

`HookDecision::Forward` — relay the (possibly modified) message.
`HookDecision::Block(status, body)` — respond with an error without forwarding.

Current implementation: `NoopHook` (pass-through). Wire it in `main.rs` — swap
`Arc::new(transform::NoopHook)` for a real implementation.

For `application = "https"` the gateway opens its own TLS session to the
upstream (`connect_tls_upstream`).  The TLS SNI hostname is taken from the
handshake's `sni` field when present, falling back to `target`.  When
`GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS=true` (the default), the certificate
chain is not verified — appropriate for medical devices with self-signed certs.

Limits (current):
- Header buffer: 64 KiB per message.
- Body buffer: **16 MiB** per message (hard cap; no streaming).
- HTTP/2 is not supported.

### Guacamole mode

When `guac: true` is set in the handshake, the gateway connects to the local
guacd daemon (`GUACD_ADDR`, default `127.0.0.1:4822`) instead of opening a raw
TCP connection to the target.  guacd speaks native RDP/VNC/SSH to the device
and the gateway bridges the Guacamole instruction stream bidirectionally to the
client WebSocket.

**Base image:** `guacamole/guacd:1.6.0` (upgraded from 1.5.0 to fix a VNC
authentication bug in libvncclient).

**Supported protocols:** `rdp`, `vnc`, `ssh`.

**guacd opening handshake** (`guac/connection.rs`):
```
client → select  <protocol>
guacd  ← args    <ordered list of param names>
client → size / audio / video / image  (capability instructions)
client → connect <value for each param in args order>
guacd  ← ready   <connection_id>
```
After `ready` the stream is raw Guacamole instructions bridged bidirectionally.

**Reconnect / session parking:** when the browser WebSocket drops, the live guacd
`TcpStream` is parked in `config.parked_sessions` (keyed by `connection_id`) for
`GUAC_RECONNECT_GRACE_SECS` (default 30 s).  The client sends the same
`connection_id` on the next connect; the gateway unparks the stream and resumes
the session without re-running the guacd opening handshake.

Response format on successful guacd session:
```
200 CONNECTED $cf9dace0-fffd-4bef-97cc-ff3db89c18c8\n
```
The connection ID is included so the client can reconnect to the parked session.

**RDP parameters** (`guac/connection.rs` `RdpParams`):

| Field | Default | Notes |
|---|---|---|
| `hostname` | — | Target IP/host |
| `port` | 3389 | |
| `username` | `""` | Windows username |
| `password` | `None` | |
| `domain` | `None` | Leave empty for local accounts |
| `security` | `None` | `"any"` negotiated |
| `ignore_cert` | `true` | Appropriate for self-signed device certs |
| `enable_drive` | `false` | Enable virtual drive sharing |
| `drive_name` | `"FleetShell"` | Name shown in Windows Explorer |
| `drive_path` | `""` | Absolute path on gateway host; set from `GUACD_DRIVE_PATH/<target_ip>` |
| `width/height/dpi` | 1280/800/96 | Display geometry |

`drive-create-path = true` is always sent so guacd creates subdirectories automatically.

**Drive sharing directory layout** on the EFS volume:
```
/guac-drives/
  192.168.1.100/          ← device writes files here (RDP drive redirect)
    Downloads/            ← guacd writes files pushed TO the device
  192.168.1.101/
    Downloads/
```
The per-device directory is created by the gateway handler (`tokio::fs::create_dir_all`)
before calling `guac::connect()`.  `create_dir_all` is idempotent — safe for
multiple gateway containers racing on the same EFS path.

**AWS EFS** (`fleetshell-guac-drives`, `fs-0316990fe78641ae2`):
- Access point: EFS path `/guac-drives`, `posixUser: Uid=1000, Gid=1000`,
  `CreationInfo: OwnerUid=1000, OwnerGid=1000, Permissions=755`
- Security group `sg-04e471905c7422a96` allows TCP 2049 from ECS task SG
  `sg-065f9193da9f46436`
- Mounted at `/guac-drives` in the ECS task (volume name `guac-drives`,
  `transitEncryption: ENABLED`, `iam: DISABLED`)
- Shared across all gateway container instances — files from any session are
  visible on all containers

**VNC operational notes:**
- VNC only works when the Windows desktop session is **active and unlocked**.
  guacd cannot access the Windows Winlogon / lock-screen desktop.
- UltraVNC must run as a **Windows service** for console-session access;
  MS-Logon I and II must be unchecked; no DSM plugin.
- guacd 1.5.0 had a VNC authentication bug against UltraVNC; fixed in 1.6.0.
- **Unlock workflow** (for a device at the lock screen):
  1. Open an e2e RDP tunnel (port 3389, e2ecrypt checked, guac unchecked).
  2. Connect with `mstsc /admin /v:127-0-0-x.client.fleetshell.com:3389`.
  3. Log in; open a command prompt and run `tscon %SESSIONNAME% /dest:console`.
  4. The RDP window closes; the session is now live on the physical console.
  5. Open a **new** VNC guac connection — the unlocked desktop is visible.
  (The existing VNC session drops on the `tscon` desktop switch; reconnect.)
- **VNC vs RDP session identity:** VNC always mirrors the physical console
  session.  RDP creates its own virtual session (Windows Server) or takes over
  the console session (Windows 10/11 single-session).  On Windows Server, RDP
  and VNC show **different sessions**; VNC is the correct tool for observing a
  running clinical application on the console.

### What is NOT yet implemented (open work)

See [§7 Open work items — Gateway](#gateway-1).

---

## 6. Cross-cutting concerns

### JWT flow (portal → client → gateway)

```
Portal                     Client                  Gateway
  │                           │                       │
  │ POST /api/tunnel/sign     │                       │
  │ signs JWT(target,ports,gw)│                       │
  │ with JWT_SECRET            │                       │
  │─── returns token ─────────►│                       │
  │    (browser receives it)   │                       │
  │                            │─── forwards token ───►│
  │                            │    in handshake JSON  │
  │                            │                       │ verifies with JWT_SECRET
  │                            │                       │ checks target/port/gw claims
```

**`JWT_SECRET` must be the same value on both portal and gateway.**
Currently: HS256 (HMAC-SHA256). The client never inspects or validates the JWT.

### DNS requirements

Two sets of DNS records must exist and be publicly resolvable:

| Hostname pattern | Resolves to | Purpose |
|---|---|---|
| `*.client.fleetshell.com` | `127.0.0.1` | Client API (HTTPS), slot URLs |
| `127-0-0-1.client.fleetshell.com` | `127.0.0.1` | Client API host (covered by wildcard) |
| `127-0-0-{2..17}.client.fleetshell.com` | `127.0.0.1` | Slot loopback addresses |

The wildcard TLS certificate (`*.client.fleetshell.com`) covers all of the above.
Both the Windows client's OS resolver and the user's browser must be able to
resolve these names to `127.0.0.1`.

### Design principles

- **Wire protocol is minimal**: one JSON line in, one status line out, then raw bytes.
  Do not add HTTP framing or length prefixes — the client speaks only this.
- **One tokio task per active tunnel** — natural fit for the concurrency model.
- **`path` field is informational** — the gateway logs it; future use for multi-service routing.
- **`servicekey` is opaque to the gateway** — passed through for client UI display only.
- **`sni` is a routing hint** — used for transform-mode TLS SNI and Host header; not a JWT claim.
- **TLS crypto backend is ring everywhere** — both client and gateway explicitly opt out of
  `aws_lc_rs` to avoid having two providers in the same process.
- **Slot IPs are always loopback** — the OS handles routing; no network interface config needed.

---

## 7. Open work items

### Known bugs (cross-boundary)

These bugs span multiple components and require coordinated fixes.

- [ ] **BUG-1: Probe JWT expires before key-fetch** (portal ↔ client)
  The probe JWT has a 5-minute TTL.  The enrollment flow can exceed this window:
  CSR POST + 10 s simulated CA delay + polling at 3 s intervals + cert fetch + key
  fetch.  When step 6 (key fetch) fires with an expired token, the portal returns
  `401` and enrollment fails.  Fix: either extend the probe token TTL, or issue a
  separate longer-lived enrollment session token that is valid for the full
  cert/key fetch phase.

- [x] **BUG-2: Client API not upgraded to HTTPS until restart** (client) — **FIXED**
  `handle_enroll` in `portal.rs` now hot-reloads TLS immediately after writing
  the cert+key to disk: it updates a `TlsState` (`Arc<RwLock<Option<TlsAcceptor>>>`)
  held in Tauri app state.  The axum server checks the current acceptor for every
  new TCP connection, so HTTPS activates within the same process lifetime — no
  restart required.

- [ ] **BUG-3: Portal Connect form fails for pre-enrollment or just-enrolled clients** (portal ↔ client)
  The devices page always fetches `https://127-0-0-1.client.fleetshell.com:8080/api/tunnel`.
  Before enrollment (or before restart after first enrollment) the API server is
  HTTP, so the browser's HTTPS fetch returns a network error.  The form should
  detect this and fall back to `http://127.0.0.1:8080/api/tunnel`, or the client
  should activate HTTPS dynamically (see BUG-2).

### Portal

- [ ] LE certificate for `portal.fleetshell.com`
- [ ] Device entry form: allow entering machine details as they would come from MDM
      (IP address, hostname, OS type, serial number, etc.) and persist to Redis
- [ ] Ability to retrieve LE certificates (ACME client or integration)
- [ ] Ability to perform LE web-based auth challenges
- [ ] Convert the portal welcome page into a guided multi-step enrollment page
      with more space and step-by-step instructions

### Client

- [x] **Phase 1**: Persist the unique client ID returned by the enrollment
      deep-link — stored as `client_id` in `AppConfig` (TOML)
- [x] **Phase 1**: Client submits a placeholder CSR to `/api/cert/request` using
      the enrollment Bearer token; polls `/api/cert/status` until `"ready"`,
      fetches the cert from `/api/cert/get`, fetches the private key from
      `/api/cert/key`, then confirms via `/api/cert/confirm`
- [x] **Phase 1**: Portal serves one shared wildcard cert (`*.client.fleetshell.com`)
      from `certs/client.pem` and its private key from `private/client.key`
- [x] **Phase 1**: Client activates an inbound HTTPS listener (via `serve_tls`) using
      the received cert and key — hot-reloads immediately after enrollment (BUG-2 fixed)
- [x] 16 connection slots: `127.0.0.2` – `127.0.0.17`, managed by `SlotManager`
- [x] Slot display in `FunctionsView` with SVG arc free/busy/countdown timers
- [x] Idle-time field in Settings UI (`idle_timeout`, 10–3600 s, default 300 s)
- [ ] **Phase 1 bug (BUG-1)**: Replace placeholder CSR with a real PKCS#10 PEM
      (this also fixes token expiry because the client controls the timing)
- [ ] **Phase 1 bug (BUG-2)**: Hot-reload TLS after enrollment without requiring restart
- [ ] **Phase 2**: Client generates a pub/private key pair
- [ ] **Phase 2**: Client creates a CSR for `*.<uniquename>.client.fleetshell.com`
- [ ] **Phase 2**: Client sends real CSR to the portal
- [ ] Add a `Connect`/`Tunnel` variant to `DeepLinkPayload` so the portal can
      trigger full tunnel sessions via deep-link (not just enrollment) — currently
      the portal uses direct HTTP POST to `/api/tunnel` instead

### Gateway

- [ ] **Dockerfile** — build a minimal static container image
      (`FROM scratch` or `FROM alpine`, copy the musl binary)
- [x] **AWS infrastructure** — NLB deployed and wired to the ECS service:
      - ACM certificate on the NLB for `gateway.fleetshell.com`; NLB listener on
        port 443 forwards plain TCP to target group (type **`ip`**, port 8443)
      - ECS service updated with load balancer config pointing to the target group
        (must be set at service creation / update — not on the NLB alone)
      - ECS task SG: inbound TCP 8443 from `0.0.0.0/0` (NLB preserves client IPs
        so the task sees real client addresses, not the NLB IP)
      - ECS task SG: inbound TCP 8080 from NLB subnet CIDRs (health checks)
      - NLB health check: **HTTP on port 8080** (not TCP on 8443) so health probes
        never appear in the tunnel handler logs
      - `JWT_SECRET` and any secrets must use `valueFrom` (Secrets Manager ARN)
        in the ECS task definition, **not** `value` (which injects the ARN string)
- [x] **Health check endpoint** — `health.rs` / `GATEWAY_HEALTH_ADDR` (`:8080`)
- [x] **Guacamole support** — RDP, VNC, SSH via guacd 1.6.0:
      - `guac/` module: `connection.rs` (handshake + `ConnectionParams`),
        `protocol.rs` (instruction encode/decode)
      - Session parking + reconnect via `parked_sessions` map
      - Per-device drive directory created before `guac::connect()`
- [x] **EFS drive sharing** — `fleetshell-guac-drives` (`fs-0316990fe78641ae2`)
      mounted at `/guac-drives`; `GUACD_DRIVE_PATH=/guac-drives`;
      per-device subdirectories (`<target_ip>/`) created on session open;
      access point with `posixUser: 1000` and `Path=/guac-drives` ensures
      guacd (UID 1000) can write without root
- [ ] **Implement concrete `TransformHook`** — currently `NoopHook` is wired in
      `main.rs`; implement at minimum:
      - Rewrite `Host:` header to the upstream target (or `sni` when present)
      - Inject auth headers if required
      - Optionally redact sensitive fields in responses
- [ ] **HTTP/2 support** in transform mode (upstream devices may require it)
- [ ] **Upstream trust store** — `GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS`
      defaults to `true`; add a `webpki-roots` path for CA-signed deployments
- [ ] **Streaming body support** in transform mode — current 16 MiB hard cap is
      unsuitable for large file transfers

### Simulated test devices (AWS VPC)

- [ ] Windows VMs in the same VPC as the gateway with RDP, VNC, HTTP, HTTPS
      servers (self-signed TLS certs are fine — mirrors real medical device setup)
