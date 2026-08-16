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
8. [Master Data Management (MDM) rebuild](#8-master-data-management-mdm-rebuild)

---

## 1. Repository layout

```
fleetshell/
├── Cargo.toml                  # Cargo workspace (resolver = "2")
│                               # members: fleetshell-client/src-tauri, fleetshell-gateway,
│                               #          squid-infoproxy, test-guac
├── Cargo.lock
├── AGENTS.md                   # ← this file
├── TODO.md                     # Detailed task tracking
├── .cargo/config.toml          # Cross-compile target: x86_64-pc-windows-gnu (MinGW posix-threads)
├── scripts/
│   ├── build-windows-x64.sh   # Cross-compile helper; --installer flag triggers NSIS packaging
│   ├── get_jwt.sh              # Mint a tunnel JWT via the production portal (requires session cookie)
│   ├── get_jwt.ps1             # PowerShell equivalent of get_jwt.sh
│   └── mint_jwt.sh             # Mint a JWT locally without the portal (uses JWT_SECRET directly;
│                               #   default secret matches the gateway dev default)
│
├── fleetshell-portal/          # SvelteKit web portal (Node.js / TypeScript)
│   ├── package.json
│   ├── svelte.config.js
│   ├── src/
│   │   ├── app.css             # Gruvbox tokens; @xterm/xterm CSS; Victor Mono NF @font-face
│   │   ├── hooks.server.ts     # Session auth guard (redirects to /login)
│   │   ├── lib/
│   │   │   ├── components/
│   │   │   │   └── AppShell.svelte       # Sidebar + page wrapper
│   │   │   ├── guacamole-common-js.d.ts  # TypeScript declarations for guacamole-common-js
│   │   │   ├── fontfaceobserver.d.ts     # TypeScript declarations for fontfaceobserver
│   │   │   └── server/
│   │   │       ├── constants.ts          # ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET
│   │   │       ├── jwt.ts                # issueProbeToken / verifyProbeToken / issueTunnelToken (+ record claim)
│   │   │       ├── redis.ts              # Singleton Redis client (ioredis)
│   │   │       ├── s3.ts                 # Singleton S3 client; listRecordingDays/Sessions; presignedDownloadUrl
│   │   │       └── session.ts            # Cookie-based session helpers
│   │   └── routes/
│   │       ├── login/                    # Static username/password login
│   │       ├── logout/                   # Cookie clear + redirect
│   │       ├── welcome/                  # First-run page → directs user to Support then Devices
│   │       ├── (app)/                    # Auth-guarded app shell
│   │       │   ├── devices/              # IP-based device lookup + Connect form (incl. Record checkbox)
│   │       │   ├── session/              # Unified viewer: Guacamole (RDP/VNC) + xterm.js (SSH)
│   │       │   ├── support/              # Client download + fleetshell:// enrollment link
│   │       │   ├── settings/             # (placeholder)
│   │       │   └── administration/       # Device search (Valkey) + S3 recording browser
│   │       └── api/
│   │           ├── client/probe/[id]/    # POST — probe from client, store in Redis
│   │           ├── clients/              # POST — get/create stable client ID, issue probe JWT
│   │           ├── probes/[id]/stream/   # GET (SSE) — streams probe result to browser
│   │           ├── enrollment/[id]/stream/ # GET (SSE) — streams enrollment events to browser
│   │           ├── tunnel/sign/          # POST — sign a tunnel JWT server-side (incl. record flag)
│   │           ├── administration/
│   │           │   ├── devices/              # GET ?q= — search Valkey systems:by-ip:* keys
│   │           │   └── recordings/           # GET ?ip=&day=&session= — S3 listing + presigned ZIP URL
│   │           └── cert/
│   │               ├── request/          # POST — accept CSR, store cert chain, publish cert-ready
│   │               ├── status/           # GET  — poll cert issuance status (none|pending|ready)
│   │               ├── get/              # GET  — fetch the issued certificate chain (PEM)
│   │               ├── key/              # GET  — fetch the shared private key (PEM)
│   │               └── confirm/          # POST — client confirms receipt; marks enrollment done
│   ├── static/
│   │   └── fonts/                    # Victor Mono NF woff2 faces (Regular/Bold/Italic/BoldItalic)
│   ├── certs/client.pem        # (deprecated) now injected via CLIENT_CERT env var
│   ├── private/client.key      # (deprecated) now injected via CLIENT_KEY env var
│   └── support/apps/[filename]/ # GET — serves client installer download
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
│           ├── server.rs       # Axum router on 127.0.0.1:8080; TLS acceptor; tunnel handlers
│           ├── tunnel.rs       # Port-spec parser, GatewayConn enum, connect_gateway(),
│           │                   #   slot-based TCP listeners, TLS/plain-TCP gateway sessions
│           ├── slot.rs         # SlotManager: 16 loopback slots (127.0.0.2–17), idle monitor
│           ├── portal.rs       # Deep-link decoder/dispatcher, enrollment orchestrator
│           ├── config.rs       # AppConfig struct (TOML), cert/key persistence helpers
│           ├── guac_proxy.rs   # Per-slot WebSocket server; bridges browser ↔ gateway guacd stream
│           ├── ssh_proxy.rs    # Per-slot WS server for SSH direct mode; bridges xterm.js ↔ gateway ssh.rs
│           └── util.rs         # navigate(), show_window() helpers
│
├── fleetshell-gateway/         # Standalone Rust TCP/TLS tunnel gateway
│   ├── Cargo.toml
│   ├── Dockerfile              # 3-stage: Rust builder + guacenc builder + guacamole/guacd runtime
│   ├── scripts/
│   │   └── run.sh              # Starts guacd, fleetshell-gateway, guacrecord; fixes AWS cred URI
│   └── src/
│       ├── main.rs             # Tokio accept loop, optional TLS handshake, spawns tasks
│       ├── config.rs           # Config::from_env() — all settings via env vars
│       ├── auth.rs             # JWT verify_connection(), Claims struct (incl. record), AuthError
│       ├── recording.rs        # RecordingMeta, write_job_file, new_recording_name, SESSION_SEQ
│       ├── handler.rs          # Parse → auth → probe/ssh-direct/guac/proxy; recording path setup
│       ├── health.rs           # HTTP health-check server on GATEWAY_HEALTH_ADDR (:8080)
│       ├── ssh.rs              # Direct SSH handler (russh): PTY alloc, shell, framed relay
│       ├── tls.rs              # build_acceptor(): self-signed (rcgen) or file-based PEM
│       ├── transform.rs        # HTTP/1.1 transform proxy + TransformHook trait + NoopHook
│       ├── bin/
│       │   └── guacrecord.rs   # Post-processor: inotify → guacenc → keys.txt/srt/zip → S3
│       └── guac/
│           ├── mod.rs          # Re-exports ConnectionParams, RdpParams, VncParams, SshParams
│           ├── connection.rs   # guacd handshake; to_value_map() (incl. recording-path/name/keys)
│           └── protocol.rs     # Instruction encode/decode; async I/O helpers
│
└── test-guac/                  # Smoke-test tool: connect to guacd or gateway
    ├── Cargo.toml              # rustls dependency for optional TLS in gateway mode
    └── src/main.rs             # Direct guacd mode + gateway mode (GATEWAY_TLS=true)

└── squid-infoproxy/            # Rust Squid external_acl_type helper (Info Proxy authz)
    ├── Cargo.toml              # rustls/ring + ipnet; no async runtime (blocking helper)
    ├── README.md               # deployment + Squid config
    └── src/
        ├── main.rs             # CLI + stdin OK/ERR loop (fail-closed)
        ├── valkey.rs           # minimal blocking RESP client (AUTH/SELECT/SMEMBERS), rediss
        └── matcher.rs          # destination-rule matching (CIDR/DNS-suffix/port/proto)
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
  /session page ◄──wss://────  (guac WebSocket)  ──────────────► guacd → device
  /session page ◄──wss://────  (ssh-ws WebSocket) ──────────────► russh → device
```

### Full tunnel sequence

```
  Browser / portal     fleetshell-client (:8080)     fleetshell-gateway (:443)     Target device
       |                        |                              |                         |
       |─POST /api/tunnel/sign─►| (stays on portal server)    |                         |
       |◄─{ token }─────────────|                              |                         |
       |─POST /api/tunnel──────►| (127-0-0-1.client.fleetshell.com:8080)                |
       |                        |─bind TcpListener(slot_ip:P)  |                         |
       |◄─200 { ports, urls }───|                              |                         |
  Local app ──TCP:slot_ip:P─────►|                              |                         |
                                 |─TCP/TLS connect─────────────►|                         |
                                 |─JSON handshake + \n─────────►|─verify JWT              |
                                 |◄─"200 CONNECTED\n"───────────|─TCP connect────────────►|
                                 |◄══════raw bytes═══════════════════════════════════════►|
```

### Guacamole tunnel sequence

```
  Browser /session     fleetshell-client (guac_proxy)   Gateway + guacd       Target device
       |                        |                              |                    |
       |─wss://{slot}:P/guac-ws►|                              |                    |
       |                        |─TCP/TLS connect─────────────►|                    |
       |                        |─JSON {guac:true,...}\n──────►|─guacd handshake    |
       |                        |◄─"200 CONNECTED $uuid\n"─────|─VNC/RDP/SSH───────►|
       |◄══Guacamole instructions════════════════════════════════════════════════════|
```

### SSH xterm.js tunnel sequence

```
  Browser /session     fleetshell-client (ssh_proxy)    Gateway (ssh.rs)      Target device
       |                        |                              |                    |
       |─wss://{slot}:P/ssh-ws──►|                              |                    |
       |                        |─TCP/TLS connect─────────────►|                    |
       |                        |─JSON {application:"ssh",guac:false,...}\n────────►|─SSH auth+PTY──────►|
       |                        |◄─"200 CONNECTED\n"───────────|                    |
       |◄═[0x00/0x01 frames]════►|◄═══raw PTY bytes═══════════►|                    |
```

**SSH framing protocol (after `200 CONNECTED`):**

| Direction | Format | Meaning |
|---|---|---|
| browser → gateway | `[0x00][len_hi][len_lo][...data]` | Keyboard input → PTY stdin |
| browser → gateway | `[0x01][0x00][0x04][rows_hi][rows_lo][cols_hi][cols_lo]` | PTY resize (SIGWINCH) |
| gateway → browser | raw bytes, no framing | PTY stdout/stderr |

The client `ssh_proxy.rs` bridge is transparent to the framing — it copies bytes
verbatim in both directions as `Message::Binary` WebSocket frames.

### Deep-link / probe sequence (enrollment)

```
  Portal (browser)           fleetshell-client               Portal (API)
       |─opens fleetshell://───►|─POST /api/client/probe/─────►|
       |   {type:enroll,id,jwt} |   {version, arch}            |
       |◄─SSE probe result──────────────────────────────────────|
       |                        |─POST /api/cert/request───────►|
       |                        |─poll /api/cert/status─────────|
       |                        |─GET  /api/cert/get────────────|
       |                        |─GET  /api/cert/key────────────|
       |                        |─POST /api/cert/confirm────────|
       |◄─SSE enrollment-confirmed──────────────────────────────|
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
| JWT | Custom HS256 (Node.js `crypto`, no external lib) |
| Styling | Custom CSS (Gruvbox palette, CSS custom properties) |
| SSH terminal | xterm.js (`@xterm/xterm` 6.x) + WebGL/canvas renderer |
| SSH font | Victor Mono NF (Nerd Font, woff2) — self-hosted in `/static/fonts/` |
| S3 client | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (recording browser) |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ADMIN_USERNAME` | — | Portal login username |
| `ADMIN_PASSWORD` | — | Portal login password |
| `SESSION_SECRET` | — | Cookie signing key |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_SECRET` | `change-me-in-production` | HMAC secret for tunnel + probe JWTs |
| `CLIENT_CERT` | — | PEM certificate chain — injected from AWS Secrets Manager via `valueFrom` |
| `CLIENT_KEY` | — | PEM private key — injected from AWS Secrets Manager via `valueFrom` |
| `GUACD_S3_BUCKET` | — | S3 bucket for recording browser (e.g. `dev-s3-fleetshell`) |
| `AWS_REGION` | — | AWS region used by the S3 client (`@aws-sdk/client-s3`) |

### What is implemented

- **Static login** — username/password form, signed session cookie, auth guard in
  `hooks.server.ts` redirects all `(app)` routes to `/login`.
- **JWT helpers** — `lib/server/jwt.ts`:
  `issueProbeToken`, `verifyProbeToken`, `issueTunnelToken` — all HS256 via
  Node.js native `crypto` with timing-safe comparison.
- **Redis persistence** — singleton client; `clients:<id>` hashes; `systems:by-ip:<ip>`.
- **Enrollment flow** — full sequence from `/support`; see §4 Client for details.
- **Static certificate (Phase 1)** — shared wildcard `*.client.fleetshell.com` cert
  and key loaded from `CLIENT_CERT` / `CLIENT_KEY` env vars (AWS Secrets Manager).
- **Device lookup + Connect form** (`/devices`) — Redis IP lookup + Connect form:
  - Applications: http / https / rdp / vnc / ssh / expert-i
  - Per row: Guac, E2E, Open checkboxes; Path sub-row (SNI + URL suffix); Guac
    sub-row (Width/Height/DPI + Drives for RDP)
  - On submit: sign JWT server-side → POST to client API
- **Tunnel JWT signing** — `POST /api/tunnel/sign` (auth-guarded).
- **Client installer** — `GET /support/apps/[filename]` streamed from disk.
- **Session page** (`/session`) — unified full-screen viewer for both Guacamole
  (RDP/VNC) and SSH xterm.js sessions, selected by URL parameters:
  - Opened in a new tab with `?ws=<wss-url>` (and `&proto=ssh` for SSH sessions).
  - Session type detection: `?proto=ssh` or `wsUrl.includes('/ssh-ws')` → SSH path;
    otherwise → Guacamole path.

  **SSH / xterm.js path** (`isSsh === true`):
  - Loads `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`,
    `@xterm/addon-image`, `@xterm/addon-unicode11`, `@xterm/addon-unicode-graphemes`
    in parallel via dynamic `import()`.
  - Waits for all four Victor Mono NF font faces (regular/bold/italic/bold-italic)
    via `fontfaceobserver` before opening the terminal (prevents wrong cell-width
    measurements if xterm.js initialises before the font loads).
  - Gruvbox Dark Hard colour theme applied to the terminal.
  - `WebglAddon` loaded first; falls back to canvas renderer silently if WebGL
    is unavailable.
  - `FitAddon` + `ResizeObserver` keep the terminal sized to the available area
    and send PTY resize frames on every geometry change.
  - **Left toolbar (SSH mode)**: A− | fontSize px | A+ | Fullscreen | Disconnect
    (font-size steps: 8–28 px; changed via 100 ms interval polling `fontSize`
    reactive state, then `fit.fit()` + resize frame sent to gateway).
  - Keyboard input → `sshFrameData()` (`0x00` frame).
  - Resize → `sshFrameResize()` (`0x01` frame, 4-byte payload: u16 BE rows, cols).

  **Guacamole path** (`isSsh === false`, unchanged):
  - **Left toolbar** (44 px wide, full-height, monochrome SVG icons):
    Fit | 1:1 | Zoom+ | % | Zoom− | Clipboard | Files (placeholder) | Fullscreen | Disconnect
  - **Scaling** via `display.scale(factor)` — mouse coordinate remapping is
    automatic (`sendMouseState(state, true)`); no manual remapping needed
  - **Auto-fit on load**: `display.onresize` fires on first `size` instruction from
    guacd; fit-scale computed from actual toolbar width
    (`toolbarEl.getBoundingClientRect().width`) + `CANVAS_PAD = 8` px + 1 px
    safety margin to prevent sub-pixel scrollbar flicker
  - **Fullscreen**: `fullscreenchange` listener recalculates fit after transition;
    fullscreen icon = outer corner brackets; fit icon = 4 outward diagonal arrows
  - **Cursor overflow fix**: `overflow: hidden` on `.display` clips the guacd
    cursor-sprite layer so it cannot expand the scroll area
  - **Clipboard bidirectional**: paste button → remote (`StringWriter`); remote →
    browser (`onclipboard` + `StringReader`)
  - **SSR safety**: `onMount` is sync and returns cleanup; async setup (both SSH
    and Guacamole) runs in a fire-and-forget inner IIFE (avoids `window is not
    defined` in SSR)

- **Devices form SSH handling**: `ssh` rows with `guac:false` and `e2ecrypt:false`
  default to xterm.js mode; E2E checkbox is enabled so the user can opt into raw
  TCP passthrough instead.  `tunnelBody()` now includes `width`/`height` for SSH
  rows (not just guac rows) so the gateway can compute initial PTY dimensions.
  Result URL detection checks for `/ssh-ws` in the URL to open `/session?…&proto=ssh`.

- **Session recording** — Guac sub-row in `/devices` has a **Record** checkbox
  (all protocols: RDP, VNC, SSH-via-guacd).  When ticked:
  - `record: true` is embedded in the signed JWT by `POST /api/tunnel/sign`.
  - `issueTunnelToken` accepts an optional `record` boolean; only embedded when
    `true` to keep tokens compact.
  - The session URL gains `&record=1`; the `/session` page shows a full-screen
    **recording notice overlay** before connecting to the device.  The
    `Guacamole.Keyboard` handler is only attached *after* the user dismisses
    the overlay (clicking "Understood"), preventing keystrokes from reaching the
    device until acknowledged.

- **Administration page** (`/administration`) — device search + recording browser:
  - **Device search**: searches Valkey `systems:by-ip:*` keys by IP or any field
    value via `GET /api/administration/devices?q=`.
  - Results table shows all hash fields (serial, product, partno, country, …)
    with a **Recordings** button per device.
  - **Recording days**: `GET /api/administration/recordings?ip=` lists S3 day
    prefixes (`guacamole/recordings/<ip>/YYYY-MM-DD/`) newest first.
  - **Session list**: `GET /api/administration/recordings?ip=&day=` lists sessions
    for that day (detected by `.meta.json` objects in S3).
  - **Download**: `GET /api/administration/recordings?ip=&day=&session=` returns
    a 15-minute presigned URL for the session `.zip` bundle; browser downloads
    directly from S3 (no portal bandwidth used).

### What is NOT yet implemented

See §7 Open work items — Portal below.

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
| Local API | axum 0.8 on `127.0.0.1:8080` (HTTP or HTTPS) |
| TLS (outbound) | tokio-rustls 0.26 + rustls-native-certs (OS trust store) |
| TLS (inbound API) | tokio-rustls 0.26 + rustls (ring provider) |
| HTTP client | reqwest 0.12 (rustls-tls-native-roots) |
| Logging | tauri-plugin-log |

**Current version: 0.12.4** — keep `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` in sync manually on every bump.

### Tauri commands

| Command | Description |
|---|---|
| `get_config` | Load `AppConfig` from TOML |
| `save_config` | Persist `AppConfig` to TOML |
| `get_log_history` | Return last N log lines |
| `enrollment_login` | POST credentials to portal `/api/login` |

### AppConfig (persisted as TOML)

```toml
# %APPDATA%\com.fleetshell.client\config\config.toml
font_size                = 15       # UI font size in px
vnc_viewer               = ""       # Path to TigerVNC viewer; empty = search PATH
portal_base_url          = "https://portal.fleetshell.com"
idle_timeout             = 300      # Idle seconds before slot released (10–3600)
client_id                = "..."    # Set after first enrollment; absent until then
gateway_skip_tls_verify  = false    # Accept self-signed gateway certs — dev only
gateway_disable_tls      = false    # Plain TCP to gateway (no encryption) — debug only
```

Both TLS settings are surfaced in Settings → Connections with ⚠️ dev-only warnings.

### Certificate / key storage

| Path | Content |
|---|---|
| `<id>.pem` | PEM cert chain (wildcard `*.client.fleetshell.com`) |
| `<id>.key` | PEM private key |
| `<id>.csr` | CSR (placeholder in Phase 1) |
| `archive/<id>_<ts>.<ext>` | Previous identity files rotated on re-enrollment |

### Local API server

Binds to `127.0.0.1:8080`.  Hot-reloads TLS after enrollment via `TlsState`
(`Arc<RwLock<Option<TlsAcceptor>>>`).  No restart required.

#### `POST /api/tunnel`

Request: `target`, `token`, `gateway`, `servicekey?`, `username?`, `password?`,
`width?`, `height?`, `dpi?`, `enable_drive?`, `enable_record?`, `port_rows[]`.

Each `port_rows` entry: `ports`, `application`, `guac?`, `e2ecrypt?`, `sni?`, `path?`.

Response 200: `{ status, ports[], urls[], bind_ip, remaps[] }`.
`remaps[]` lists any local-port reassignments as `{ requested, actual, reason }`
(see "Local vs target port decoupling" above); the portal resolves native
RDP/VNC launch ports through it so an "Open" button targets the actual port.

#### Gateway connection abstraction (`tunnel.rs`)

`GatewayConn` enum (`Plain(TcpStream)` / `Tls(TlsStream<TcpStream>)`) implements
`AsyncRead + AsyncWrite + Unpin`.  `connect_gateway(addr, host, skip_verify,
disable_tls)` selects the right variant.  Used by raw-tunnel, probe, guac proxy,
and SSH proxy code paths.  The old `GATEWAY_SKIP_TLS_VERIFY` env var is removed;
both flags live in `AppConfig`.

#### SSH direct proxy (`ssh_proxy.rs`)

Mirrors `guac_proxy.rs` structure but simpler — no Guacamole framing, no session
parking.

- `SshProxyParams` carries: target, port, ws_port, token, username, password,
  width, height, gateway, slot_idx, last_active, skip_tls_verify, disable_tls.
- `run_ssh_slot()` — per-slot accept loop identical to `guac_proxy`; handles
  optional TLS for the inbound WebSocket.
- Route: `GET /ssh-ws` → WebSocket upgrade → `handle_ssh_ws()`.
- `handle_ssh_ws()` connects to the gateway, sends JSON handshake with
  `{application:"ssh", guac:false, ...}`, reads `200 CONNECTED\n`, then calls
  `bridge()` which copies bytes verbatim in both directions.
- Port remapping: SSH port 22 is browser-blocked; remapped to 50022 by the same
  `guac_ws_port()` helper used by guac proxy.
- `tunnel_handler` three-way partition:
  1. `guac_flat`    — `guac:true` → Guacamole canvas
  2. `ssh_flat`     — `application:"ssh"` + `e2ecrypt:false` → xterm.js WS
  3. `regular_flat` — everything else incl. `ssh+e2ecrypt:true` → raw TCP tunnel

### Connection slots

16 loopback slots: `127.0.0.2` (slot 0) … `127.0.0.17` (slot 15), each with a
DNS hostname `127-0-0-{N}.client.fleetshell.com` covered by the wildcard cert.
`SlotManager` handles claim / release and idle monitoring.

**Local vs target port decoupling.** The local listen port is only a
browser/native-app rendezvous; the *target* service port always travels to the
gateway inside the signed JWT + handshake JSON, never via the local port.
`bind_slot_port()` (server.rs) binds `slot_ip:<requested>` and, on
`AddrInUse` (WSAEADDRINUSE/10048) **or** `PermissionDenied`
(WSAEACCES/10013), falls back to an OS-assigned ephemeral port
(`bind(slot_ip:0)` + `local_addr()`).  This works around two Windows quirks:
a third-party socket on the wildcard `0.0.0.0:<port>` shadows that port number
across every local address (10048), and Windows also *reserves/excludes* port
ranges (Hyper-V/WSL dynamic ranges, `netsh` exclusions, exclusive-use sockets)
which fail as 10013 rather than "in use".  Either way the slot bind fails even
though nothing listens on the slot IP.
When a fallback happens the actual port is used everywhere it is surfaced
(returned `ports[]`, browser/`wss` URLs, generated `.rdp`/`.vnc` files) and a
remap notice `{ requested, actual, reason }` is emitted in the `slot-update`
Tauri event; FunctionsView shows a `⇄` marker + tooltip on the slot.  For
regular TCP rows the local and target ports are threaded separately through
`run_accept_loop(listener, local_port, target_port, …)`.

### Per-application behaviour

| application | Local action | URLs returned |
|---|---|---|
| `http` | none | `http://{slot-dns}:{port}{path}` |
| `https` | none | `https://{slot-dns}:{port}{path}` |
| `expert-i` | none | `https://{slot-dns}:{port}{path}` |
| `rdp` | writes `.rdp`, launches `mstsc.exe` | none |
| `vnc` | writes `.vnc`, tries TigerVNC / vncviewer | none |
| guac rows | binds WebSocket listener on slot IP (`/guac-ws`) | `wss://` URL |
| `ssh` (guac:false, e2ecrypt:false) | binds WebSocket listener on slot IP (`/ssh-ws`) | `wss://…/ssh-ws` URL |
| `ssh` (e2ecrypt:true) | raw TCP tunnel, no local action | none |

### Gateway handshake payload (client → gateway)

```json
{
    "target": "192.168.13.133", "application": "https", "port": 443,
    "token": "<jwt>", "gateway": "atlanta-01", "sni": "device.example.com",
    "path": "/service/tunnel/", "e2ecrypt": false,
    "guac": false, "username": "Administrator", "password": "<pw>",
    "width": 1920, "height": 1080, "dpi": 96,
    "enable_drive": false, "enable_record": false, "connection_id": null
}
```

### Enrollment orchestrator (`handle_enroll`)

| Step | Action |
|---|---|
| [1/7] | Archive old identity; persist `client_id` |
| [2/7] | POST probe `{version, arch}` + Bearer token |
| [3/7] | POST cert request `{id, csr:"placeholder"}` |
| [4+5/7] | Poll cert status; fetch + persist cert |
| [6/7] | Fetch + persist private key |
| [7/7] | POST cert confirm |

### UI tabs

| Tab | Component | Purpose |
|---|---|---|
| `functions` | `FunctionsView` | 16-slot grid (SVG arc timers) + service key clipboard |
| `settings` | `SettingsView` | Font, VNC viewer, portal URL, idle timeout, TLS flags |
| `logging` | `LogView` | Live log stream |
| `enrollment` | inline | Portal URL, credentials, Enroll button |

### Build / packaging

```bash
./scripts/build-windows-x64.sh            # binary only
./scripts/build-windows-x64.sh --installer # + NSIS user-level installer
```

### What is NOT yet implemented

See §7 Open work items — Client below.

---

## 5. Component: fleetshell-gateway

### Tech stack

| Layer | Technology |
|---|---|
| Language | Rust (edition 2021) |
| Async runtime | tokio 1 (full) |
| TLS server | tokio-rustls 0.26 + rustls 0.23 (ring) |
| Self-signed cert | rcgen 0.14 |
| JWT | jsonwebtoken 10 (HS256) |
| HTTP parsing | httparse 1 (transform mode) |
| Serialisation | serde + serde_json |
| Logging | tracing + tracing-subscriber |
| SSH (direct mode) | russh 0.62 (ring backend, no aws-lc-rs) |
| Build target | `x86_64-unknown-linux-musl` |

### Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_LISTEN_ADDR` | `0.0.0.0:8443` | TCP listen address |
| `JWT_SECRET` | `change-me-in-production` | **Always override in production** |
| `TLS_CERT_FILE` | *(none)* | PEM cert chain (only when `GATEWAY_TLS=true`) |
| `TLS_KEY_FILE` | *(none)* | PEM private key (only when `GATEWAY_TLS=true`) |
| `GATEWAY_TLS` | `false` | `true` = gateway terminates TLS (local/standalone); `false` = NLB does it |
| `GATEWAY_HEALTH_ADDR` | `0.0.0.0:8080` | HTTP health-check listener |
| `GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS` | `true` | Skip upstream cert verification |
| `GUACD_ADDR` | `127.0.0.1:4822` | guacd daemon (co-located in container) |
| `GUACD_DRIVE_PATH` | *(none)* | Root path for RDP drive sharing; per-device subdirs auto-created |
| `GUACD_RECORDING_PATH` | *(none)* | Root path for session recordings; e.g. `/guac/recordings` (EFS mount) |
| `GUACD_JOBS_PATH` | `<GUACD_RECORDING_PATH>/jobs` | Directory watched by `guacrecord` for job files |
| `GUACD_S3_BUCKET` | *(none)* | S3 bucket for recording uploads; skipped when unset |
| `GUACD_S3_REGION` | `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS region for S3 uploads |
| `GUAC_RECONNECT_GRACE_SECS` | `30` | How long to park guacd stream after WebSocket drop |
| `RUST_LOG` | `info` | `debug` for per-connection detail |

**Local dev without NLB:** set `GATEWAY_TLS=true`.  Without cert/key files a
self-signed cert is auto-generated via rcgen.  Client needs `gateway_skip_tls_verify`
or `gateway_disable_tls` (plain TCP).

### Wire protocol

**Handshake (client → gateway, newline-terminated JSON):**

```json
{"target":"192.168.13.133","application":"https","port":443,
 "token":"<jwt>","gateway":"atlanta-01","sni":"device.example.com",
 "path":"/service/tunnel/","e2ecrypt":false}
```

**Status response (gateway → client, single line):**

| Response | Meaning |
|---|---|
| `200 CONNECTED\n` | Proxy mode or SSH direct mode entered |
| `200 CONNECTED $uuid\n` | guac mode — reconnect ID included |
| `400 BAD REQUEST\n` | Unparseable JSON |
| `401 UNAUTHORIZED\n` | Invalid/expired JWT |
| `403 FORBIDDEN\n` | Claims mismatch (target/port/gateway) |
| `503 UNREACHABLE\n` | Probe mode — target unreachable |
| `502 BAD GATEWAY\n` | Cannot connect to target or guacd |

After `200 CONNECTED`: raw byte pipe.

### JWT claims

```json
{"sub":"alice","iat":1784325058,"exp":1784411458,
 "target":"192.168.13.187","ports":"443,3000-3020","gw":"atlanta-01",
 "record":true}
```

`gw` is optional; when present the handshake `gateway` field must match.
`record` is optional; when `true` the gateway sets up a recording path and
`guacrecord` will post-process the session after it ends.

### Source module responsibilities

| File | Responsibility |
|---|---|
| `main.rs` | Accept loop; optional TLS; spawn handler + health tasks |
| `config.rs` | `Config::from_env()` — incl. `guacd_recording_path`, `guacd_jobs_path` |
| `auth.rs` | `verify_connection()` — JWT decode + claims check (incl. `record`); `port_in_spec` unit tests |
| `recording.rs` | `RecordingMeta` struct; `write_job_file()`; `new_recording_name()` (ms timestamp + atomic seq); `now_ms()` |
| `handler.rs` | Parse → auth → SSH-direct / probe / guac / transform/e2e; builds `RecordingMeta`; writes job file on session end (both Case 1: guacd-closed and Case 2: park-grace expired) |
| `health.rs` | HTTP health-check; probes at DEBUG only |
| `ssh.rs` | Direct SSH via `russh`: `SshParams`, `AcceptAllKeys` handler, PTY alloc, shell, framed relay loop |
| `tls.rs` | `build_acceptor()` — PEM files or rcgen self-signed |
| `transform.rs` | HTTP/1.1 proxy; `TransformHook` trait; `NoopHook`; `SkipServerVerification` |
| `bin/guacrecord.rs` | Post-processor binary: inotify watch on `jobs/`; runs `guacenc`; extracts keystrokes; writes `.keys.txt`, `.srt`, `.meta.json`, `.zip`; uploads to S3 via OpenDAL |
| `guac/connection.rs` | guacd handshake; `ConnectionParams` enum; `to_value_map()` (incl. `recording-path`, `recording-name`, `recording-include-keys`) |
| `guac/protocol.rs` | `Instruction` encode/decode; `write_instruction` / `read_instruction` |

### Transform mode

When `e2ecrypt: false`, the gateway uses HTTP/1.1 proxy mode.

For `application = "https"` **or `"expert-i"`**, the gateway opens a TLS session
to the upstream device.  SNI taken from `sni` field, falling back to `target`.
Both applications behave identically in transform mode.

```rust
pub trait TransformHook: Send + Sync {
    fn on_request (&self, msg: &mut HttpMessage);
    fn on_response(&self, msg: &mut HttpMessage);
}
```

Current implementation: `NoopHook` (pass-through).
Limits: 64 KiB headers, 16 MiB body, no HTTP/2.

### Direct SSH mode

When `application = "ssh"`, `guac: false`, and `e2ecrypt: false`, the gateway
bypasses guacd entirely and speaks SSH natively via `russh`.

- `SshParams` → `ssh::run()` → TCP connect to target:22 → password auth → PTY
  (`xterm-256color`, initial cols/rows derived from `width/8` and `height/16`) →
  interactive shell → bidirectional framed relay.
- `AcceptAllKeys` handler accepts all SSH host keys (TOFU can be layered later).
- Initial PTY cols/rows: `cols = (width / 8).max(40)`, `rows = (height / 16).max(10)`.
- When `e2ecrypt: true` for `application:"ssh"`, falls through to raw TCP
  passthrough so a native SSH client can connect through the tunnel unmolested.

### Guacamole mode

When `guac: true`, the gateway connects to guacd instead of the target.

**Supported protocols:** `rdp`, `vnc`, `ssh` (guacd path).

**Key implementation details:**
- `VncParams` carries `username` — required for macOS Screen Sharing (ARD auth);
  an empty username causes guacd to silently fail VNC authentication.
- guacd handshake: `select → args → size/audio/video/image → connect → ready`
- Session parking: guacd stream kept alive for `GUAC_RECONNECT_GRACE_SECS` after
  WebSocket drop; resumed when client sends the same `connection_id`.
- RDP drive sharing: `GUACD_DRIVE_PATH/<target_ip>/` created via
  `tokio::fs::create_dir_all`; shared across containers via AWS EFS
  (`fleetshell-guac-drives`, `fs-0316990fe78641ae2`).

**VNC operational notes:**
- macOS: always supply username (ARD authentication requires it).
- Windows UltraVNC: run as service; MS-Logon I/II unchecked; no DSM plugin.
- guacd 1.6.0 fixes a VNC auth bug present in 1.5.0.
- Lock screen workaround: open e2e RDP → `tscon` to console → reconnect VNC.

### Session recording

When the portal's **Record** checkbox is ticked, `record: true` is embedded in
the signed JWT.  The gateway verifies this claim and sets up a recording path.

**File layout on EFS:**
```
/guac/recordings/
  <target_ip>/
    <ms>-<seq>.guac         ← guacd writes raw recording
    <ms>-<seq>.m4v          ← guacrecord: guacenc output
    <ms>-<seq>.keys.txt     ← guacrecord: keystroke transcript
    <ms>-<seq>.srt          ← guacrecord: subtitles
    <ms>-<seq>.zip          ← guacrecord: bundle (.guac+.m4v+.keys+.srt+.meta)
    <ms>-<seq>.meta.json    ← guacrecord: session metadata
  jobs/
    <conn_id>.json          ← gateway writes when session ends
    done/<conn_id>.json     ← guacrecord moves here after processing
```

**Session end triggers** (two cases):
- **Case 1** (guacd closed): gateway writes job JSON immediately in `relay_guac`
  `else` branch.
- **Case 2** (park grace expired): gateway writes job JSON in the grace-timer task.

**`guacrecord` post-processor:**
- Runs as a background process in the same container (started by `run.sh`).
- Watches `jobs/` with a single inotify handle (one watch regardless of device count).
- Per job: `guacenc -s WxH` → rename `.guac.m4v` → `.m4v`; parse `.guac` for
  keystroke events (timestamp + keysym, normalised to session-relative ms);
  segment by 2 s pause or 72-char wrap; write `.keys.txt` and `.srt`; create
  `.zip`; upload all 6 files to S3 via OpenDAL.
- S3 key: `guacamole/recordings/<ip>/YYYY-MM-DD/<session>.<ext>`.
- OpenDAL uses the ECS task role credentials via
  `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`.  **Known issue**: reqsign incorrectly
  uses `ECS_CONTAINER_METADATA_URI` as the credential endpoint base.  Worked
  around in `run.sh` by computing and exporting
  `AWS_CONTAINER_CREDENTIALS_FULL_URI=http://169.254.170.2${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`
  before starting `guacrecord`.

**guacd recording parameters sent by the gateway:**
- `recording-path` — per-device directory
- `recording-name` — `<ms>-<seq>.guac` (pre-generated, deterministic)
- `recording-include-keys` — `true` (keyboard events embedded in `.guac`)
- `create-recording-path` — `true`

**`guacenc` note:** must be compiled with `libwebp-dev` (added to the
`guacenc-builder` Docker stage).  Without WebP support, guacenc silently drops
WebP-encoded RDP frames, producing artefacts in the output video.

### What is NOT yet implemented

See §7 Open work items — Gateway below.

---

## 6. Cross-cutting concerns

### JWT flow

```
Portal ─signs JWT(target,ports,gw[,record]) with JWT_SECRET─► returns token to browser
Browser ─forwards token in POST /api/tunnel─► Client ─forwards in handshake JSON─► Gateway
Gateway ─verifies with JWT_SECRET, checks claims (incl. record)─► accepts or rejects
```

**`JWT_SECRET` must be identical on portal and gateway.**

**Local dev token minting** (no portal required):
```bash
# Uses change-me-in-production by default — matches gateway dev default
./scripts/mint_jwt.sh 192.168.13.187 5900 127.0.0.1:8443

# With a specific secret
JWT_SECRET="my-secret" ./scripts/mint_jwt.sh 192.168.13.187 5900 127.0.0.1:8443

# Via production portal (requires session cookie from /login)
./scripts/get_jwt.sh $COOKIE_VALUE
```

`test-guac`'s `GATEWAY_NAME` defaults to the `--gateway` address, so the `gw`
JWT claim matches automatically without extra env vars.

### DNS requirements

| Hostname | Resolves to | Purpose |
|---|---|---|
| `*.client.fleetshell.com` | `127.0.0.1` | Client API + slot URLs |
| `127-0-0-1.client.fleetshell.com` | `127.0.0.1` | Client API host |
| `127-0-0-{2..17}.client.fleetshell.com` | `127.0.0.2..17` | Slot loopback addresses |

### Design principles

- Wire protocol is minimal: one JSON line in, one status line out, then raw bytes.
- One tokio task per active tunnel.
- `gateway_disable_tls` / `GATEWAY_TLS=false` are dev-only.  Production always uses TLS.
- TLS crypto backend is `ring` everywhere — no `aws_lc_rs`.
- Slot IPs are loopback — no network interface config needed.

---

## 7. Open work items

### Known bugs (cross-boundary)

- [ ] **BUG-1: Probe JWT expires before key-fetch** (portal ↔ client)
  5-minute TTL can expire before step 6 (key fetch) in slow environments.
  Fix: extend TTL in `issueProbeToken`, or issue a separate longer-lived
  enrollment token.

- [x] **BUG-2: Client API not upgraded to HTTPS until restart** — **FIXED**
  Hot-reload via `TlsState` (`Arc<RwLock<Option<TlsAcceptor>>>`).

- [ ] **BUG-3: Connect form does not handle all client states** (portal ↔ client)
  The portal has two paths (HTTPS success / HTTPS fail→deep-link) but there are
  five distinct states requiring different UX.  Detection sequence on Connect:
  1. Try HTTPS (`127-0-0-1.client.fleetshell.com:8080`) — enrolled + running
  2. TypeError → try HTTP (`127.0.0.1:8080`, W3C loopback exception allows this
     from an HTTPS page) — not enrolled + running → show enrollment gate
  3. TypeError → open `fleetshell://` wake deep-link, poll both for ~10 s:
     - HTTPS responds → enrolled, was sleeping → "Starting…" → proceed
     - HTTP responds  → not enrolled, was sleeping → "Starting…" → enrollment gate
     - Timeout        → not installed → "Not found — [Download ↓]"

  **Enrollment gate** (not-enrolled states): warn that HTTPS/guac/expert-i sessions
  will not work; offer **[Enroll now →]** (`/support?action=enroll`) and
  **[Continue anyway]** (proceeds over HTTP; HTTPS result URLs marked ⚠️).

  **Wake deep-link**: `fleetshell://e30` (base64url `{}`) launches the app without
  side-effects, OR implement `type: "wake"` → `show_window()` in the client.

  Files: `devices/+page.svelte`, `support/+page.svelte`, optionally
  `fleetshell-client/src-tauri/src/portal.rs`.

### Portal

- [ ] LE certificate for `portal.fleetshell.com`
- [ ] Device entry form (IP, hostname, OS, serial) persisted to Redis
- [ ] ACME client / LE cert retrieval and challenge handling
- [ ] Guided multi-step enrollment welcome page
- [ ] **File manager panel** in `/session` — toolbar button placeholder is already
      present; implement slide-out panel listing `/guac-drives/<target_ip>/`
      contents with upload/download
- [ ] Recording playback in administration page — `Guacamole.SessionRecording`
      API can play `.guac` files directly in the browser via presigned URL

### Client

- [x] Phase 1: `client_id` in AppConfig; placeholder CSR; cert+key fetch+confirm
- [x] Phase 1: HTTPS API hot-reload after enrollment (BUG-2 fixed)
- [x] 16 loopback slots; FunctionsView SVG arc timers; idle-timeout setting
- [x] `GatewayConn` enum + `connect_gateway()` — plain-TCP / TLS / skip-verify
- [x] `gateway_skip_tls_verify` and `gateway_disable_tls` in AppConfig + SettingsView
- [x] SSH direct mode: `ssh_proxy.rs` — per-slot `/ssh-ws` WebSocket, raw byte bridge
- [x] `tunnel_handler` three-way partition: guac / ssh-direct / raw-TCP
- [ ] **BUG-1**: probe JWT TTL / key-fetch auth
- [ ] **BUG-3**: full client-state detection + enrollment gate (see §7 Known bugs)
- [ ] `type: "wake"` deep-link — `DeepLinkPayload::Wake` calls `show_window()`
- [ ] Phase 2: real PKCS#10 CSR + per-client key pair
- [ ] `Connect`/`Tunnel` deep-link variant

### Gateway

- [x] **Dockerfile** — 3-stage build: Rust musl binary + guacenc (with WebP/FFmpeg/Cairo) + guacamole/guacd:1.6.0 runtime
- [x] AWS NLB infrastructure wired and working
- [x] Health check endpoint; Guacamole RDP/VNC/SSH via guacd 1.6.0
- [x] RDP drive sharing via EFS (`fleetshell-guac-drives`)
- [x] `expert-i` fix: TLS upstream now used for both `"https"` and `"expert-i"`
- [x] VNC username: `VncParams.username` wired from handshake (fixes macOS ARD auth)
- [x] `relay_guac()` expanded debug: per-direction byte counts, EOF/error
      distinction, explicit `flush()` after client writes, iteration counter
- [x] Direct SSH mode: `ssh.rs` (russh 0.62) — PTY, shell, framed relay, all SSH modes
- [x] Session recording: `record` JWT claim, `recording.rs`, `guacrecord` binary,
      S3 upload via OpenDAL, `.guac`/`.m4v`/`.keys.txt`/`.srt`/`.zip`/`.meta.json`
- [ ] Concrete `TransformHook`: rewrite `Host:` header, inject auth headers
- [ ] HTTP/2 support in transform mode
- [ ] Proper upstream trust store (`webpki-roots`) for CA-signed deployments
- [ ] Streaming body support (current 16 MiB cap)

### Test tooling (`test-guac`)

- [x] TLS support in gateway mode (`GATEWAY_TLS=true`) via rustls `GatewayStream`
- [x] `GATEWAY_NAME` defaults to `--gateway` address (matches `gw` JWT claim)
- [ ] Token expiry display in banner
- [ ] `--protocol` as a positional flag (currently env var only)

### Simulated test devices (AWS VPC)

- [ ] Windows VMs with RDP, VNC, HTTP, HTTPS (self-signed certs)

---

## 8. Master Data Management (MDM) rebuild

A parallel effort replacing the Valkey key/value store as the system of record
for device/gateway/customer relations and authorization. **New agents working on
MDM: read `docs/mdm_status.md` first** (start-here handoff), then
`docs/mdm_design.md`, `docs/authz_caching.md`, `docs/data_import.md`,
`docs/portal_ui.md` (portal-dev UI: AppShell shell + section roadmap), and
`docs/data_classification.md` (data-classification feature + import pipeline).

### New components (not in §1's original layout)

```
fleetshell-portal-dev/       # NEW SvelteKit portal, served under /dev/ (base path)
  src/lib/components/
    AppShell.svelte           #   brand top-bar + icon-rail sidebar (Nucleus look)
    Logo.svelte               #   inlined Siemens Healthineers wordmark (--logo-fg)
    PagePlaceholder.svelte    #   stub card for not-yet-built sections
    GroupTree.svelte          #   reusable expandable group tree (Groups + Grants tabs)
    ScopePicker.svelte        #   chip multi-select over a search API (Grants scope builder)
    ConfirmDialog.svelte      #   in-page styled confirm modal (replaces window.confirm)
  src/lib/nav.ts              #   sidebar source of truth (PRIMARY_NAV / UTILITY_NAV)
  src/lib/server/identity.ts  #   person(login_account)/persona(app_user) helpers
  src/lib/server/password.ts  #   scrypt hash/verify (dev login; SAML/OAuth later)
  src/lib/server/session.ts   #   signed cookie {accountId, active userId}
  src/routes/login/           #   password login
  src/routes/select-persona/  #   post-login persona picker + top-bar switcher target
  src/routes/(app)/           #   auth-guarded shell group (account -> persona)
    devices/ gateways/ products/ customers/ support/ settings/
    administration/           #   admin-gated tabbed sub-nav
      accounts/ personas/     #     built: login accounts + identities (paginated)
      roles/                  #     built: role list + editable privilege matrix (CRUD x types)
      groups/                 #     built: group TREE (GroupTree) + grants (read) + member mgmt
      grants/                 #     built v1: group-centric grant builder (device + group scopes)
  src/routes/api/administration/  # search APIs: groups, personas, regions, products, customers, sites
  src/lib/server/db.ts        #   postgres.js pools: global + local Aurora
  src/lib/server/authz.ts     #   resolveGroupIds (local) + listDevices/can (global)
  src/lib/server/theme.ts     #   Nucleus/Gruvbox theme resolution (cookie/DB/admin)
  src/app.css                 #   design tokens (data-theme)
  ws-server.js / server.js    #   base-path-aware WebSocket + prod entry (node server.js)
  theme-reference/*.png       #   Siemens Healthineers "Remote Service" look to match
  theme-reference/logo.div    #   source of the Healthineers wordmark SVG
  theme-reference/logo.div    #   source of the Healthineers wordmark SVG

infrastructure/
  make_aurora_global.sh        # Aurora Global DB (master data + authz), + reader + RDS Proxy
  make_aurora_local.sh         # Standalone Aurora (user PII + group membership)
  sql/
    schema_global.sql          # master data + polymorphic authz model + region ltree
    schema_local.sql           # login_account + app_user personas + group_membership
    authz_resolve.sql          # reference authz functions (executable spec)
    authz_fastpath.sql         # INDEX-USING authz_list_devices / authz_can (production)
    migrate_region_access.sql  # region hierarchy + graded access_requirement
    migrate_region_tree.sql    # region_id_seq for user-created sub-regions (Countries > Region Tree)
    migrate_dtm.sql            # Data Transfer Matrix: data_class(kind/mrs_id), dtm_variant/matrix/deny, customer.dtm_variant
    migrate_user_country.sql   # (LOCAL) app_user.country (ISO), imported from RDUSER.COUNTRYID
    migrate_customer_site.sql  # customer/site address fields + contacts + resolve_site_membership()
    migrate_theme_*.sql        # per-user theme + org default
    migrate_identity_local.sql # person/persona split + region-prefixed text user_id
    migrate_identity_primary.sql # account_persona.is_primary (default persona)
    migrate_persona_rename.sql # account_identity -> account_persona (naming consistency)
    migrate_authz_catalog.sql  # normalize privileges to CRUD x extensible types (+ device:connect)
    migrate_data_classification.sql # data_class catalog + classification_set/rule/rule_class/assignment
    seed_demo.sql / verify_demo.sql   # correctness proof (all green)
  import/
    load.py                    # anonymizing CSV importer (192k devices, ~1M grants; incl. single-system)
                               #   + --stage families / --stage classification (name-keyed, reload-survivable)
    classification_dedup.py    # Data_Classification*.xlsx -> classification.json (lossless support dedup + CIM)
    classification_export.py   # DB -> classification.json round-trip (capture UI edits, then commit)
    classification.json        # committed, name-keyed data-classification artifact (source of truth)
    product_families.json      # committed family -> product-names mapping (populates product.family)
    anonymize.py               # IdMap/LabelMap/fakers (destroyed after run)
    build_group_hierarchy.py   # materialize the full group tree (path/parent_id) from groups.txt
    seed_test_users.py         # curated broad->narrow test personas for the dev login
    seed_login_accounts.mjs    # dev login accounts + persona role_label/is_admin
    old_database/              # legacy CSV exports (gitignored; never commit)
                               #   incl. groups.txt (owner-provided group hierarchy)

docs/
  mdm_status.md                # START HERE: current state + where to start next
  data_classification.md       # data-classification feature (Rule Sets/Assignments) + import pipeline
  file_subscriptions.md        # File Subscriptions: spool key layout + delivery-runtime design (handler fleet)
  mdm_design.md                # architecture: two planes, authz model, §5.1 hard rules
  authz_caching.md             # perf: L0/L1 caches, §11 validated benchmark
  data_import.md               # import + anonymization plan
  portal_ui.md                 # portal-dev UI: AppShell (top bar + icon rail),
                               #   routing, theming, section + Administration roadmap
```

### One-paragraph model

Two-plane split: GLOBAL Aurora (master data + authz, replicated worldwide) holds
`device / gateway / customer / customer_site / product / region` + the authz
model (`privilege/role/grant/scope/scope_constraint`); LOCAL Aurora (per region)
holds `login_account` (the human) + `app_user` persona PII + `account_persona`
(N:M) + `group_membership`. Authorization is ABAC: a `grant` =
(group, role, scope); scopes are attribute predicates over region/product ltree
subtrees + customer/site, with a graded `access_requirement` (open/device/
customer/site). Hot path: resolve user->groups locally, then evaluate
groups->grants->scopes against globally-replicated master data. The list query
is index-using SQL (GiST on ltree paths), no bitmaps.

### Status: infra + schema + import + perf DONE; portal shell + Administration + Products (incl. Data Classification) + Devices + Gateways + Countries/Region Tree + Data Transfer Matrix + Customers/Sites + Services>File Subscriptions (incl. Valkey spool) + Services>Infoproxy (schema + import + UI + Valkey spool + Squid helper) DONE. Next: deploy the Squid helper + scheduled spool refresh; gateway IPsec Valkey spool.

The portal-dev application chrome is built (`docs/portal_ui.md`): brand top-bar
(Healthineers logo + "FleetShell Portal"; theme toggle, bell/news placeholder,
name/role + persona switcher, logout) and an icon-rail sidebar (Devices,
Gateways, Products, Customers/Sites, Administration; Support, Settings) matching
the Nucleus look. Every page lives in the `(app)` route group behind the guard.

Identity model: password login to a `login_account` (the human) -> a post-login
Persona Selector picks one of its linked `app_user` personas (region-prefixed
text `user_id`) -> top-bar switcher.

**Administration is fully built** (all admin-gated by the interim persona
`is_admin`): **Accounts** + **Personas** (paginated master-detail, non-unlinkable
default persona); **Roles** (editable privilege matrix = fixed CRUD verbs x
extensible resource types + `device:connect`); **Groups** (a real expandable
tree via `GroupTree.svelte`; grants shown decoded as `Region | Product |
Customer[/Site]`; member management); **Grants v1** (group-centric builder:
role + resource-typed scope -- device dims region/product/customer/site OR group
subtree -- decomposed into one grant per combination; `ScopePicker` +
`ConfirmDialog` components). Data: single-system grants imported;
`build_group_hierarchy.py` materializes the full group tree from `groups.txt`.

Apply order after a reload: `migrate_identity_local.sql` +
`migrate_identity_primary.sql` + `migrate_persona_rename.sql` (local) +
`migrate_authz_catalog.sql` + `migrate_product_model.sql` +
`migrate_device_identity.sql` + `migrate_gateway_enrich.sql` +
`migrate_gateway_ipsec.sql` + `migrate_gateway_hostname.sql` (global; the last
five run BEFORE `load.py`), `build_group_hierarchy.py --apply`, then
`seed_login_accounts.mjs | psql` (accounts `super/super123`, `nora/nora123`).
See `docs/mdm_status.md` "Re-running the data pipeline / full reload".

**Primary sections built** (see `docs/portal_ui.md` + `docs/product_admin.md`):
- **Products** (`/products`): modality>product>model tree (`kind` discriminator,
  `family`, `product_model` satellite = partno/serial-range/host-flag,
  `product_model_app` = the Connect-app defaults via `AppEditor.svelte`). Models
  imported from `RDPRODUCTMODEL`.
- **Devices** (`/devices`): Google-style search (`sn:`/`fl:`/`ip:`/`tid:`/`host:`/
  `ord:`), admin scope toggle, keyset paging (~455ms; count URL-carried),
  view/edit/create/delete, `EntityPicker` relations, partno, city, and a
  **read-only inherited Applications** list (from the model's
  `product_model_app`). Identity fields imported anonymized from
  RDSERVICEDSYSTEM; `product_path` points at the model (via PRODUCTMODELID).
- **Gateways** (`/gateways`): browser + detail over the RS-router / communication
  interface, enriched from `RDRSROUTERDETAILVIEWV1`, attached-devices relation,
  and the **IPsec/tunnel editor** (`IpsecEditor.svelte`; `public_ip`+`psk`+`ipsec`
  jsonb = the legacy Valkey SiteRecord). `dns_name` repurposed -> nullable
  `hostname` (DynDNS); `public_ip` synthesized.
- **Services** (`/services`): tabbed **Infoproxy | E-Mail | File Subscriptions**
  (`services/+layout.svelte`; `/services` redirects to the first tab). E-Mail is a
  placeholder. **Infoproxy is BUILT** (see the RESUME HERE block below).
  **File Subscriptions is BUILT**
  (`services/subscriptions/`): two draggable `SplitPane` tabs -- **Subscriber
  Servers** (delivery-target CRUD: name/ip_address/country/use-case/comment/
  activated + delivery method ADLS|S3|SCP + root path / use-partno-folder /
  container-or-sub-path + method-specific `auth` jsonb -- ADLS service-principal
  or default, S3 access-key or assume-role, SCP user/pass; secrets PLAINTEXT in
  the jsonb; detail lists attached subscriptions with remove + search-add via
  `?/saveServerSubs`) and **Subscriptions** (matcher CRUD: name + optional
  modality/product pickers (product scoped to modality) + PCRE `pattern` +
  `negate`; detail attaches to servers via a tickable server grid via
  `?/saveSubServers`). Both save-set actions rewrite one side's
  `subscription_server` in a txn (no giant matrix -- 282x56 locked the browser). A
  `Save to Valkey` spool-out button on both views is **WIRED** (`spoolValkey` ->
  `src/lib/server/subscriptions.ts` `syncToValkey`, standalone mirror
  `scripts/spool-subscriptions.mjs`): per device product it resolves the
  applicable subscriptions (global + modality-wide + product) x ALL their
  delivery targets into the product-keyed hash
  `ftp_subscriptions:<MODALITY>:<PRODUCT>` for aeroftp (server objects carry
  `activated`; deactivated servers are NOT skipped -- their jobs still queue
  during downtime and deliver on reactivation). The delivery RUNTIME
  (aeroftp -> Valkey list+pubsub -> handler fleet -> per-server job queues) is
  designed in `docs/file_subscriptions.md` (next: a new top-level Rust package).
  Schema
  `migrate_file_subscriptions.sql` (`subscriber_server` / `subscription` /
  `subscription_server`). Data imported by `import/import_subscriptions.py`
  (gitignored xlsx -> 56 servers / 282 subs / 297 attachments; honors ANONYMIZE;
  in `reload.sh`). New endpoint `/api/administration/product-picker` (product-UUID
  type-ahead, optional `mod` filter); `EntityPicker` gained `extraParams`.
- UI consistency: shared `.actions-bar`/`.act-*` (Delete left, Cancel, Save/
  Create right; red delete via `ConfirmDialog`), `SplitPane` (draggable,
  persisted), dark scrollbars, in-field search x + keep-focus. Section layout
  wrappers (Products/Countries/Services/Admin) no longer cap at 80rem -- they fill
  the viewport width like Customers.

**Services > Infoproxy is now COMPLETE (schema + import + UI + Valkey spool +
Squid helper).** RESUME HERE next session: DEPLOY the Squid helper
(the `squid-infoproxy` Rust package) on the intranet/internet Squid hosts and
schedule a spool refresh (`scripts/spool-infoproxy.mjs`), then the File
Subscriptions Valkey spool + the gateway IPsec Valkey spool.
**Services > Infoproxy** (proxy/Squid destination authorization) is fully built:
schema + legacy import + UI + the runtime spool-out + helper.

- **Schema DONE + LIVE** (`infrastructure/sql/migrate_infoproxy.sql`, folded into
  `schema_global.sql`, in `reload.sh` after `migrate_file_subscriptions.sql`).
  **Three tables:**
  - `proxy_destination_rule_collection` (id, name, **proxy_type** intranet|internet,
    description; UNIQUE(proxy_type,name)) -- a NAMED container of rules ("iPad Rule
    Collection"). Purely administrative; **NOT** an authz group. `proxy_type`
    picks which Squid (intranet vs internet) serves it.
  - `proxy_destination_rule` (id, collection_id, target_cidr, target_dns,
    target_port_from, target_port_to, protocol; CHECK cidr OR dns). A rule is
    **ONLY an allowed target** -- no device/product scope. Always in a collection.
  - `proxy_destination_binding` (id, collection_id, device_id|NULL, product_id|NULL)
    -- the SCOPE. Applies a collection to a device (NULL=ANY) and/or product MODEL
    (NULL=ANY; product.kind='model'). Reusable. Partial UNIQUE indexes prevent
    duplicate device/product bindings + enforce a single ANY/ANY per collection.
    Match: `(device_id IS NULL OR =D) AND (product_id IS NULL OR =D's model)`;
    both NULL = global.
- **Legacy data IMPORTED (`import/import_infoproxy.py`, in `reload.sh` after
  `import_subscriptions.py`).** 16 collections / 391 rules / 2198 bindings
  (2111 device-precise + 75 model + 8 global + intranet). Sources (gitignored
  old_database/): `infoproxy_rules_intranet.txt` (intranet defs + assignment),
  `infoproxy_rules_internet.txt` (internet collection defs), and the authoritative
  **`table-export.html`** (internet assignment grid; supersedes the scrambled
  `info_proxy_internet.txt` PDF). Per-device attribution: legacy Customer System ==
  `RDSERVICEDSYSTEM.NAME`, resolved via **`sysname_device.map.json`** (NAME->device
  UUID) which `load.py` stage_devices writes and, crucially, does NOT destroy with
  the id maps (logged explicitly). Loose ANY/ANY inline rules -> synthetic
  "Intranet/Internet Global (imported)" collections.
- **UI BUILT (`services/infoproxy/+page.*`).** SplitPane: left = collection list
  (single-line rows like admin>Roles: name + right-aligned `N url` chip + `N mdl` /
  `N sys` counts or `ANY`), a search box + two proxy-type chips
  (Internet/Intranet, both on by default) + orange `+ New`. Right = two sub-tabs:
  **Destinations** (permitted-URL rules grid; replace-all `?/saveRules`) and
  **Applies to** (three-tier scope: global `All systems` checkbox `?/toggleAny`;
  **Product models** via `ScopePicker` over `/api/administration/models`,
  replace-all `?/saveModels`; **Individual systems** searchable/incremental via
  `/api/administration/proxy-binding` GET/POST/DELETE -- the GET does AND-of-terms
  matching serial/IP/FL/hospital/**model name**, scales to the 2000+ device case).
  Deep link `?product=<model>` filters to collections bound to that model OR ANY
  (wired from the product-tree "View destinations" link). The `Save to Valkey`
  spool-out button is **WIRED** (`spoolValkey` -> `src/lib/server/infoproxy.ts`
  `syncToValkey`). `/api/administration/models` also returns `id`.
- **Runtime BUILT: Squid `external_acl_type` helper + Valkey spool.** The spooler
  (`src/lib/server/infoproxy.ts`, wired to `spoolValkey`; standalone mirror
  `scripts/spool-infoproxy.mjs`) flattens binding->collection->rule OFFLINE into a
  per-source-IP allow-list in Valkey (Squid sees only the source IP; device
  modality/product/serial resolved at spool time via `device.ip_address -> device
  -> model (product.path = device.product_path) -> matching bindings`). Key layout
  `infoproxy:<proxy_type>:<source_ip>` = SET of TAB-delimited
  `dns\tcidr\tport_from\tport_to\tprotocol` members; per proxy_type (intranet vs
  internet = separate Squids); missing key = default DENY; each key rewritten
  single-key DEL+SADD with stale-key UNLINK pruning. The Squid helper is
  the Rust top-level package `squid-infoproxy` (rustls/ring RESP client; O(1) `%SRC` SMEMBERS + `%DST`/`%PORT`
  match; `%PROTO` advisory unless `--strict-proto`; one instance per proxy type;
  Squid config example in its docstring). Chosen over pre-generated squid.conf
  fast ACLs (linear `http_access` scan blows up on the single-system binding
  volume). ICAP is content adaptation, not the ACL mechanism. REMAINING
  (deploy-only): install the helper on the Squid hosts + a scheduled spool
  refresh. Later: importer refresh when a fuller legacy export lands.
- Full detail in `docs/mdm_status.md` (WHERE TO START NEXT item 3) and the spec in
  `docs/product_admin.md` sec 4.

**Also open (see `docs/mdm_status.md` WHERE TO START NEXT):** (1) the
device **per-device app override** (`device_app` table + `resolve_apps` +
override editor -- the device
Applications list is currently read-only/inherited); (2) the **Valkey spool** of
`gateway.ipsec`/`psk` to `fleetipsec:*` so a test device can connect; (3)
single-system grant creation (now unblocked by the device browser). Later: slice C
(group-membership `authz_can` replacing `is_admin`), L0/L1 Valkey caches (+
re-benchmark), real SAML/OAuth, and the Dockerfile + ECS/ALB `/dev/*` deploy.
NOTE: `product_model_app` is empty in the DB today -- define apps on a model and
its devices inherit them. The **File Subscriptions Valkey spool** is now BUILT
(`src/lib/server/subscriptions.ts` + `scripts/spool-subscriptions.mjs`;
product-keyed hash `ftp_subscriptions:<MODALITY>:<PRODUCT>` for aeroftp).

### Hard rules (do not break — see `docs/mdm_design.md` §5.1)

NULL device attribute = does NOT match; graded `access_requirement` gating;
region/product are ltree subtree scopes; grant inheritance is ancestor-or-self;
grant-on-grant needs the "can't grant what you don't hold" subset guard.
