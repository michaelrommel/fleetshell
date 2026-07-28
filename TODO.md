# FleetShell — TODO

## Active bugfixes (high priority)

### BUG-1 · Probe JWT expires before key-fetch (portal ↔ client)

**Symptom:** enrollment fails at step 6 (key fetch) with HTTP 401.

The probe JWT issued at `POST /api/clients` has a 5-minute TTL.  The enrollment
sequence that follows (CSR POST → 10 s CA delay → polling → cert fetch → key fetch)
can exceed this window in slow or retry-heavy environments.

**Fix options:**
- Extend TTL to 15–30 min in `issueProbeToken` (`portal/src/lib/server/jwt.ts`).
- Issue a separate longer-lived enrollment token for steps 6–7 only.
- Make `/api/cert/key` auth-free (UUID as discriminator, like `/api/cert/confirm`).

**Files:**
- `fleetshell-portal/src/lib/server/jwt.ts`
- `fleetshell-portal/src/routes/api/cert/key/+server.ts`
- `fleetshell-portal/src/routes/api/clients/+server.ts`
- `fleetshell-client/src-tauri/src/portal.rs`

---

### ~~BUG-2~~ · Client API HTTPS not activated until restart — **FIXED**

Hot-reload via `TlsState` (`Arc<RwLock<Option<TlsAcceptor>>>`).  `handle_enroll`
updates the shared state after writing cert+key; the axum server picks up the new
acceptor on the next TCP connection.  No restart required.

---

### BUG-3 · Connect form does not handle all client states (portal ↔ client)

**Symptom:** clicking Connect fails or produces broken result URLs depending on
whether FleetShell is running and enrolled.  The portal currently has only two
paths (HTTPS success → show result; HTTPS failure → deep-link) but there are
five distinct client states that each require different UX.

**Mixed-content note:** `http://127.0.0.1` is listed as a *potentially
trustworthy URL* in the W3C Secure Contexts spec, so an HTTPS portal page **can**
`fetch()` from `http://127.0.0.1:*` without being blocked.  The custom hostname
`http://127-0-0-1.client.fleetshell.com:8080` is **not** exempt and must never
be used as an HTTP fallback.

**Detection sequence** (runs on Connect click):

```
Step 1 → POST https://127-0-0-1.client.fleetshell.com:8080/api/tunnel
Step 2 → on TypeError: POST http://127.0.0.1:8080/api/tunnel
Step 3 → on TypeError: open fleetshell:// wake deep-link, poll both for ~10 s
Step 4 → on poll timeout: give up
```

| HTTPS | HTTP | Poll result | Client state | UX |
|---|---|---|---|---|
| ✅ 200 | — | — | Enrolled + running | Normal — show result |
| ❌ | ✅ 200 | — | **Not enrolled + running** | Enrollment gate |
| ❌ | ❌ | HTTPS responds | **Enrolled, not started** | "Starting…" spinner → normal |
| ❌ | ❌ | HTTP responds | **Not enrolled, not started** | "Starting…" spinner → enrollment gate |
| ❌ | ❌ | Timeout | Not installed / unresponsive | "Not found — [Download ↓]" |

**Enrollment gate** (states 2 and 4):

> ⚠️  FleetShell client is not enrolled
>
> Browser sessions (HTTPS, Expert-i, Guac RDP/VNC/SSH) require an enrolled
> certificate and will not work.
>
> Works without enrollment: HTTP connections · Native RDP/VNC/SSH (no Guac)
>
> **[Enroll now →]**  (→ `/support?action=enroll`)   **[Continue anyway]**

"Continue anyway" proceeds with `http://127.0.0.1:8080`; any HTTPS/guac result
URLs are marked ⚠️ to warn the user they will not open.

**Wake deep-link** — any `fleetshell://` URL launches the app if not running
(OS protocol handler) and brings it to front if it is.  Use either:
- `fleetshell://e30` (base64url of `{}` — client ignores unknown payload, app starts)
- or implement `type: "wake"` in the client dispatcher (calls `show_window()`;
  cleaner than relying on silent ignore of an unrecognised type)

**Files to touch:**
- `fleetshell-portal/src/routes/(app)/devices/+page.svelte` — `doConnect()`,
  new state machine, enrollment gate UI
- `fleetshell-portal/src/routes/(app)/support/+page.svelte` — read
  `?action=enroll` query param and scroll to / activate the enrollment card
- `fleetshell-client/src-tauri/src/portal.rs` — add `DeepLinkPayload::Wake`
  variant that calls `show_window()` (optional but cleaner)

---

## Feature work

### Portal

- [ ] LE certificate for `portal.fleetshell.com`
- [ ] Device entry form (IP, hostname, OS, serial) → persist to Redis
      `systems:by-ip:<ip>` hash
- [ ] ACME client / LE cert retrieval + challenge handling
- [ ] Guided multi-step enrollment welcome page
- [ ] **File manager panel** in `/session` page:
      - Toolbar 🗂 button placeholder is already present
      - Implement a slide-out panel listing `/guac-drives/<target_ip>/` contents
      - Upload (browser → device via EFS) and download (device → browser)
      - Requires gateway to expose a file-list/download API or use the EFS mount directly
- [x] `CLIENT_CERT` / `CLIENT_KEY` env vars (AWS Secrets Manager `valueFrom`)
- [x] Connect form: `path` sub-row (URL suffix + SNI); `drive` checkbox (RDP guac)
- [x] Connect form: SNI moved from main row into path sub-row
- [x] Session page (`/session`) with toolbar, scaling, clipboard, overflow fix

### Client

- [x] Phase 1: `client_id` in AppConfig; placeholder CSR → cert+key fetch → confirm
- [x] Phase 1: HTTPS API hot-reload after enrollment (BUG-2 fixed)
- [x] 16 loopback connection slots (SlotManager)
- [x] FunctionsView: SVG arc free/busy/countdown timers per slot
- [x] SettingsView: idle-timeout field; gateway TLS settings
- [x] `GatewayConn` enum + `connect_gateway()` — plain-TCP / TLS / skip-verify
      Used by all three gateway connection sites: raw tunnel, probe, guac proxy
- [x] `gateway_skip_tls_verify` — accept self-signed gateway certs (dev)
- [x] `gateway_disable_tls` — plain TCP to gateway (debug)
- [x] Guacamole WebSocket proxy (`guac_proxy.rs`):
      - `run_guac_slot`: per-slot axum router + WebSocket handler
      - TLS connect to gateway, JSON handshake, Guacamole instruction bridge
      - Session reconnect via `live_connection_id` across WebSocket drops
      - `enable_drive` field wired through to gateway handshake
- [ ] **BUG-1**: probe JWT TTL fix
- [ ] **BUG-3**: full client-state detection + enrollment gate in Connect form
- [ ] `type: "wake"` deep-link variant — `DeepLinkPayload::Wake` calls `show_window()`;
      used by the portal when the client is not running
- [ ] Phase 2: real PKCS#10 CSR + per-client key pair
- [ ] `Connect`/`Tunnel` deep-link variant (currently portal uses direct HTTP POST)

### Gateway

- [ ] **Dockerfile** — `FROM scratch` or `FROM alpine` with musl binary
- [x] AWS NLB wired; ECS service + target group; SG rules; health check on :8080
- [x] `GATEWAY_TLS=true` local dev mode — self-signed cert via rcgen, or load
      `TLS_CERT_FILE` / `TLS_KEY_FILE` for a real cert
- [x] Health check endpoint (`health.rs`, `GATEWAY_HEALTH_ADDR`)
- [x] Guacamole RDP/VNC/SSH via guacd 1.6.0:
      - `guac/connection.rs`: `ConnectionParams` enum, guacd handshake, `to_value_map()`
      - `guac/protocol.rs`: `Instruction` encode/decode, async I/O helpers
      - Session parking + reconnect (`parked_sessions`, `GUAC_RECONNECT_GRACE_SECS`)
      - `200 CONNECTED <connection_id>` for reconnect support
- [x] RDP drive sharing via EFS (`fleetshell-guac-drives`, `fs-0316990fe78641ae2`):
      - `RdpParams`: `enable_drive`, `drive_name`, `drive_path`, `drive-create-path`
      - Per-device subdirectory created with `tokio::fs::create_dir_all`
      - `GUACD_DRIVE_PATH` env var; access point `posixUser: Uid=1000`
- [x] **`expert-i` fix**: transform mode opens TLS upstream for both `"https"`
      and `"expert-i"` — previously only `"https"` got TLS; `"expert-i"` fell
      through to plain TCP and silently failed
- [x] **VNC username fix**: `VncParams` now carries `username`; wired from
      `payload.username` in handler — fixes macOS Screen Sharing (ARD auth)
      where an empty username causes guacd to silently fail VNC authentication
- [x] **`relay_guac()` debug logging**: per-direction byte counts, separate
      client-EOF vs guacd-EOF log messages, error logging with the actual error,
      explicit `flush()` after each client write, iteration counter
- [ ] Concrete `TransformHook`:
      - Rewrite `Host:` header to `sni` (when present) or `target`
      - Inject auth headers if required
      - Optionally redact sensitive response fields
- [ ] HTTP/2 support in transform mode
- [ ] Upstream trust store (`webpki-roots`) for CA-signed deployments
- [ ] Streaming body support (current 16 MiB hard cap)

### Test tooling (`test-guac`)

- [x] TLS support in gateway mode: `GATEWAY_TLS=true` triggers TLS handshake
      via `GatewayStream::Tls`; `SkipServerVerification` for self-signed certs
- [x] `GATEWAY_NAME` defaults to `--gateway` address — `gw` JWT claim matches
      automatically, no extra env var needed
- [x] `GatewayStream` enum (`Plain` / `Tls`) for shared I/O helpers
- [ ] Token expiry display (seconds remaining) in the banner
- [ ] `--protocol rdp|vnc|ssh` as a positional flag (currently env var only)

### scripts/mint_jwt.sh

- [x] Mint a tunnel JWT locally without the portal — uses `openssl` + base64
      for pure-shell HS256 signing
- [x] `JWT_SECRET` env var (default: `change-me-in-production`)
- [x] `JWT_TTL` env var (default: 86400 = 24 h)
- [x] Optional `gw` claim (third positional arg); omitted when not supplied
- [ ] Optional `sub` claim as a flag (currently always `"local-dev"`)

### Simulated test devices (AWS VPC)

- [ ] Windows VMs in the same VPC as the gateway
- [ ] Services: RDP, VNC, HTTP, HTTPS (self-signed certs are fine)
