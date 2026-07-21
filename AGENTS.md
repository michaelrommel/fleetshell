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
│   │   │       ├── jwt.ts              # signJwt / verifyJwt (HS256, jose library)
│   │   │       ├── redis.ts            # Singleton Redis client (ioredis)
│   │   │       └── session.ts          # Cookie-based session helpers
│   │   └── routes/
│   │       ├── login/                  # Static username/password login
│   │       ├── logout/                 # Cookie clear + redirect
│   │       ├── welcome/                # First-run page → directs user to Support then Devices
│   │       ├── (app)/                  # Auth-guarded app shell
│   │       │   ├── devices/            # IP-based device lookup from Redis
│   │       │   ├── support/            # Client download + fleetshell:// probe link generator
│   │       │   ├── settings/           # (placeholder)
│   │       │   └── administration/     # (placeholder)
│   │       └── api/
│   │           ├── client/probe/[id]/  # POST — receives probe from client, stores in Redis
│   │           ├── clients/            # GET — lists enrolled clients from Redis
│   │           └── probes/[id]/stream/ # GET (SSE) — streams probe result to browser
│   └── static/
│       └── fleetshell-client_0.1.0_x64-setup.exe   # Bundled client installer
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
│           ├── server.rs       # Axum router on 127.0.0.1:8080; TunnelRequest + DeepLinkForward handlers
│           ├── tunnel.rs       # Port-spec parser, TCP listeners, TLS gateway sessions
│           ├── portal.rs       # Deep-link decoder/dispatcher, enrollment_login HTTP call
│           ├── config.rs       # AppConfig struct (TOML persistence)
│           └── util.rs         # navigate(), show_window() helpers
│
└── fleetshell-gateway/         # Standalone Rust TCP/TLS tunnel gateway
    ├── Cargo.toml
    └── src/
        ├── main.rs             # Tokio accept loop, TLS handshake, spawns handler tasks
        ├── config.rs           # Config::from_env() — all settings via env vars
        ├── auth.rs             # JWT verify_connection(), Claims struct, AuthError
        ├── handler.rs          # Per-connection logic: parse → auth → connect → proxy
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
  JWT issuance               Local API :8080                  JWT verification
  Probe initiation  ──SSE──► Probe via deep-link              Bidirectional TCP proxy
  (future) connect ─────────► POST /api/tunnel ───────────────► TCP → target:port
```

### Full tunnel sequence

```
  Browser / portal     fleetshell-client (:8080)     fleetshell-gateway (:443)     Target device
       |                        |                              |                         |
       |─POST /api/tunnel──────►|                              |                         |
       |                        |─bind TcpListener(0.0.0.0:P)  |                         |
       |◄─200 { ports, urls }───|                              |                         |
       |                        |                              |                         |
  Local app ──TCP:P─────────────►|                              |                         |
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
       |  base64url({type:probe,    |─POST /api/client/probe/─────►|
       |    payload:id, token:jwt}) |   {version, arch}            |
       |                            |◄─200 OK──────────────────────|
       |◄─SSE probe result──────────────────────────────────────────|
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
| JWT | `jose` library, HS256 |
| Styling | Custom CSS (Gruvbox palette, CSS custom properties) |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ADMIN_USERNAME` | — | Portal login username |
| `ADMIN_PASSWORD` | — | Portal login password |
| `SESSION_SECRET` | — | Cookie signing key |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_SECRET` | — | HMAC secret for signing tunnel JWTs |

### What is implemented

- **Static login** — username/password form, signed session cookie, auth guard in
  `hooks.server.ts` redirects all `(app)` routes to `/login`.
- **JWT signing** — `lib/server/jwt.ts` exports `signJwt(payload, expiresIn)` and
  `verifyJwt(token)` using HS256.
- **Redis persistence** — `lib/server/redis.ts` provides a singleton client.
  Client IDs are stored as Redis hashes under `clients:<id>`.
  Device records are stored under `systems:by-ip:<ip>`.
- **Probe flow** (the enrollment handshake):
  - `/support` page generates a `fleetshell://` deep-link URL containing a
    base64url-encoded JSON probe payload `{type:"probe", payload:"<id>", token:"<jwt>"}`.
  - `POST /api/client/probe/[id]` — the client calls this endpoint after decoding
    the deep-link; the portal validates the JWT, stores the probe result in Redis,
    and publishes to a Redis Pub/Sub channel.
  - `GET /api/probes/[id]/stream` — SSE endpoint; the browser subscribes and
    receives the probe result as soon as the client posts it.
  - `/welcome` page links to Support and then to Devices.
- **Device lookup** — `/devices` page searches Redis by IP address and renders
  the raw key/value hash.
- **Client installer** — `/support` page offers `fleetshell-client_0.1.0_x64-setup.exe`
  for download (served from `/static`).

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
| Local API | axum 0.8 on `127.0.0.1:8080` |
| TLS (outbound) | tokio-rustls 0.26 + rustls-native-certs (OS trust store) |
| HTTP client | reqwest 0.12 (rustls-tls-native-roots) |
| Logging | tauri-plugin-log |

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
```

### Local API server (`127.0.0.1:8080`)

#### `POST /api/tunnel`

Accepts JSON, binds local TCP listeners, launches local applications, spawns
tunnel tasks. Returns immediately once all ports are bound.

Request:
```json
{
    "target":      "192.168.13.133",
    "application": "https",
    "ports":       "443,3000-3020",
    "token":       "<jwt>",
    "servicekey":  "abcde-...",
    "gateway":     "atlanta-01",
    "transform":   false
}
```

Response (200 OK):
```json
{ "status": "connected", "ports": [443, 3000, 3001], "urls": ["https://127.0.0.1:443"] }
```

Error responses: `409 Conflict` (port already bound), `500` (other).

| Field | Notes |
|---|---|
| `target` | Final destination host on the gateway's side |
| `application` | `"http"` \| `"https"` \| `"rdp"` \| `"vnc"` |
| `ports` | Comma-separated ports/ranges: `"443"`, `"3000-3020"`, `"443,3000-3020"` |
| `token` | JWT forwarded verbatim to the gateway handshake |
| `servicekey` | Optional — triggers Functions tab + navigate event when present |
| `gateway` | `"host"` or `"host:port"` — port defaults to 443 |
| `transform` | Optional bool — enables HTTP/1.1 transform mode on the gateway |

#### `POST /api/deep-link`

Receives a `fleetshell://` URL forwarded from a second client instance.
Dispatches into the normal deep-link handler.

```json
{ "url": "fleetshell://..." }
```

### Per-application behaviour

| `application` | Local action | URLs returned |
|---|---|---|
| `"http"` | none | `http://127.0.0.1:{port}` |
| `"https"` | none | `https://127.0.0.1:{port}` |
| `"rdp"` | writes `%TEMP%\fleetshell_rdp_{port}.rdp`, launches `mstsc.exe` | none |
| `"vnc"` | writes `%TEMP%\fleetshell_vnc_{port}.vnc`, tries `tvnviewer.exe` / `vncviewer64.exe` / `vncviewer.exe` | none |

### Tunnel lifecycle (one per port, per accepted connection)

1. `TcpListener::bind("0.0.0.0:P")` — must succeed for all ports before any task starts.
2. Accept loop spawns a task per inbound connection.
3. Each task:
   a. Connects TCP/TLS to `{gateway_host}:{gateway_port}` (TLS with OS trust store).
   b. Sends the **gateway handshake payload** (JSON + `\n`).
   c. Reads one response line.
   d. On `200 CONNECTED` → `copy_bidirectional(client_socket, gateway_socket)`.
   e. On any other response or error → log + emit `navigate { tab: "logging" }`.

### Gateway handshake payload (client → gateway)

```json
{
    "target":      "192.168.13.133",
    "application": "https",
    "port":        443,
    "token":       "<jwt>",
    "servicekey":  "abcde-...",
    "gateway":     "atlanta-01",
    "path":        "/service/tunnel/",
    "transform":   false
}
```

`port` is always a single integer (expanded from the range).
`path` defaults to `"/service/tunnel/"`.

### Deep-link handling (`fleetshell://`)

The URL host is a base64url (no padding) JSON envelope:

```json
{ "type": "enroll", "payload": "<id>", "token": "<jwt>" }
```

The client decodes it on startup (or via `/api/deep-link` forwarding) and dispatches on `type`.
Currently `"enroll"` is the only handled type.  It runs a six-step sequence:

| Step | Action |
|---|---|
| 1 | Persist `client_id` into `AppConfig` (TOML) |
| 2 | `POST {portal_base_url}/api/client/probe/{id}` — `{version, arch}` + Bearer token |
| 3 | `POST {portal_base_url}/api/cert/request` — `{id, csr: "placeholder"}` + Bearer token |
| 4 | Poll `GET {portal_base_url}/api/cert/status?id={id}` every 3 s (120 s timeout) until `"ready"` |
| 5 | `GET {portal_base_url}/api/cert/get?id={id}` — receive the certificate |
| 6 | `POST {portal_base_url}/api/cert/confirm` — `{id}` + Bearer token |

The CSR in step 3 is currently a placeholder string; a real PKCS#10 PEM will replace it in Phase 2.

### Single-instance logic

On launch, if argv[1] is a `fleetshell://` URL:
1. Try `POST http://127.0.0.1:8080/api/deep-link` with the URL.
2. If it succeeds → exit (running instance handled it).
3. If port 8080 is not reachable → continue normal startup (we are the first instance).

### UI tabs and Tauri events

| Tab | Component | Purpose |
|---|---|---|
| `functions` | `FunctionsView` | Displays service key / connected functions |
| `settings` | `SettingsView` | Font size, VNC viewer path |
| `logging` | `LogView` | Live log stream |
| `enrollment` | `EnrollmentView` | Portal URL, username/password, Enroll button |

Backend emits `"navigate"` events to switch tabs:

| Payload | Trigger |
|---|---|
| `{ tab: "functions", servicekey: "..." }` | `servicekey` present in `/api/tunnel` request |
| `{ tab: "logging" }` | Any tunnel or bind error |
| `{ tab: "logging" }` | Deep-link success or error |

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

---

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
| `TLS_CERT_FILE` | *(none)* | PEM cert chain; if absent a self-signed cert is generated |
| `TLS_KEY_FILE` | *(none)* | PEM private key (PKCS#8 or SEC1) |
| `GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS` | `true` | Skip upstream cert verification in transform mode |
| `RUST_LOG` | `info` | tracing filter |

### Wire protocol

**Step 1 — Client sends handshake (newline-terminated JSON):**

```json
{"target":"192.168.13.133","application":"https","port":443,
 "token":"<jwt>","servicekey":"...","gateway":"atlanta-01",
 "path":"/service/tunnel/","transform":false}
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
| `main.rs` | tokio accept loop; TLS handshake; spawns one task per connection |
| `config.rs` | `Config::from_env()` |
| `auth.rs` | `verify_connection()` — JWT decode + target/port/gateway claims check |
| `handler.rs` | Reads handshake, calls auth, connects to target, selects proxy mode |
| `tls.rs` | `build_acceptor()` — loads PEM files or generates self-signed cert via rcgen |
| `transform.rs` | HTTP/1.1 aware proxy loop; `TransformHook` trait; `NoopHook` impl |

### Transform mode

When `transform: true` is set in the handshake, the gateway switches to an
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

Limits (current):
- Header buffer: 64 KiB per message.
- Body buffer: **16 MiB** per message (hard cap; no streaming).
- HTTP/2 is not supported.

For `application = "https"` the gateway opens its own TLS session to the
upstream (`connect_tls_upstream`). When
`GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS=true` (the default), the certificate
chain is not verified — appropriate for medical devices with self-signed certs.

### What is NOT yet implemented (open work)

See [§7 Open work items — Gateway](#gateway-1).

---

## 6. Cross-cutting concerns

### JWT flow (portal → client → gateway)

```
Portal                     Client                  Gateway
  │                           │                       │
  │ signs JWT(target,ports,gw)│                       │
  │ with JWT_SECRET            │                       │
  │─── includes in deep-link ─►│                       │
  │    or /api/tunnel body     │                       │
  │                            │─── forwards token ───►│
  │                            │    in handshake JSON  │
  │                            │                       │ verifies with JWT_SECRET
  │                            │                       │ checks target/port/gw claims
```

**`JWT_SECRET` must be the same value on both portal and gateway.**
Currently: HS256 (HMAC-SHA256). The client never inspects or validates the JWT.

### Design principles

- **Wire protocol is minimal**: one JSON line in, one status line out, then raw bytes.
  Do not add HTTP framing or length prefixes — the client speaks only this.
- **One tokio task per active tunnel** — natural fit for the concurrency model.
- **`path` field is informational** — the gateway logs it; future use for multi-service routing.
- **`servicekey` is opaque to the gateway** — passed through for client UI display only.
- **TLS crypto backend is ring everywhere** — both client and gateway explicitly opt out of
  `aws_lc_rs` to avoid having two providers in the same process.

---

## 7. Open work items

### Portal

- [ ] LE certificate for `portal.fleetshell.com`
- [ ] Device entry form: allow entering machine details as they would come from MDM
      (IP address, hostname, OS type, serial number, etc.) and persist to Redis
- [ ] Service-launch buttons per device: RDP, VNC, HTTP, HTTPS — these should
      construct a JWT for the device and open a `fleetshell://` connect deep-link
      (or POST directly to `127.0.0.1:8080/api/tunnel` if the client is local)
- [ ] Ability to retrieve LE certificates (ACME client or integration)
- [ ] Ability to perform LE web-based auth challenges
- [ ] Portal must be able to submit a connect request directly to the locally
      running client (`POST http://127.0.0.1:8080/api/tunnel`) — currently only
      deep-links are used, and the client-side `DeepLinkPayload` only has an
      `Enroll` variant; a `Connect` / `Tunnel` variant and corresponding handler
      need to be added
- [ ] Convert the portal welcome page into a guided multi-step enrollment page
      with more space and step-by-step instructions

### Client

- [x] **Phase 1**: Persist the unique client ID returned by the enrollment
      deep-link — stored as `client_id` in `AppConfig` (TOML)
- [x] **Phase 1**: Client submits a placeholder CSR to `/api/cert/request` using
      the enrollment Bearer token; polls `/api/cert/status` until `"ready"`,
      fetches the cert from `/api/cert/get`, then confirms via `/api/cert/confirm`
- [ ] **Phase 1**: Obtain one shared wildcard cert (`*.client.fleetshell.com`)
      for bootstrapping (portal-side LE issuance not yet implemented)
- [ ] **Phase 1**: Replace placeholder CSR with a real PKCS#10 PEM
- [ ] **Phase 1**: Portal obtains signed cert from LE and sends it to the client
- [ ] **Phase 1**: Client activates an inbound HTTPS listener using the received cert
- [ ] **Phase 2**: Client generates a pub/private key pair
- [ ] **Phase 2**: Client creates a CSR for `*.<uniquename>.client.fleetshell.com`
- [ ] **Phase 2**: Client sends real CSR to the portal
- [ ] Prepare 16 loopback address slots for concurrent connections:
      `127.0.0.2` – `127.0.0.17` (one IP per active session)
- [ ] Display connection slots in the UI with a free / busy-until countdown timer
- [ ] Add idle-time field to Settings: after N seconds of no traffic, shut down the
      connection listener. Ideally per-protocol (long for http/https, short for rdp/vnc)
- [ ] Add a `Connect`/`Tunnel` variant to `DeepLinkPayload` so the portal can
      trigger full tunnel sessions via deep-link (not just enrollment)

### Gateway

- [ ] **Dockerfile** — build a minimal static container image
      (`FROM scratch` or `FROM alpine`, copy the musl binary)
- [ ] **AWS infrastructure** — NLB or ALB setup; if ALB terminates TLS, provision
      a certificate for `connect.fleetshell.com`
- [ ] **Implement concrete `TransformHook`** — currently `NoopHook` is wired in
      `main.rs`; implement at minimum:
      - Rewrite `Host:` header to the upstream target
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
