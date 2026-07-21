# FleetShell — TODO

## Active bugfixes (cross-boundary, high priority)

These bugs span multiple components and are blocking full end-to-end use.

### BUG-1 · Probe JWT expires before key-fetch (portal ↔ client)

**Symptom:** enrollment fails at step 6 (key fetch) with HTTP 401.

The probe JWT issued by `POST /api/clients` has a 5-minute TTL.  The enrollment
sequence that follows is:
1. CSR POST (step 3)
2. 10-second simulated CA delay in the portal
3. Poll `/api/cert/status` every 3 s until "ready"
4. Cert fetch (steps 4+5)
5. Key fetch **with the same probe token** (step 6)

In slow or retry-heavy environments the total elapsed time exceeds 5 minutes.

**Fix options (pick one):**
- Extend the probe token TTL to 15–30 minutes in `issueProbeToken` (portal `jwt.ts`).
- Issue a separate, longer-lived enrollment session token (e.g. 30-minute JWT) at
  `/api/clients` and use it only for cert/key fetch (steps 6–7), keeping the
  5-minute probe token for the probe step only.
- Make `/api/cert/key` not require a Bearer token (use the UUID as the
  discriminator, same pattern as `/api/cert/confirm`).

**Files to touch:**
- `fleetshell-portal/src/lib/server/jwt.ts` — `issueProbeToken` TTL or new function
- `fleetshell-portal/src/routes/api/cert/key/+server.ts` — auth check
- `fleetshell-portal/src/routes/api/clients/+server.ts` — token issuance
- `fleetshell-client/src-tauri/src/portal.rs` — `fetch_key` call / token forwarding

---

### ~~BUG-2~~ · Client API HTTPS not activated until restart — **FIXED**

**Symptom:** immediately after a successful enrollment, the portal's devices page
Connect button fails with a network error; deep-link forwarding from a second
instance falls back to HTTP.

**Root cause:** `lib.rs` builds the `TlsAcceptor` exactly once at startup.  After
`handle_enroll` writes the cert+key to disk, the running server still speaks plain
HTTP.  HTTPS only becomes active after the user restarts the app.

**Fix:** after `handle_enroll` completes successfully, hot-reload the API server
with TLS:
- Option A — restart signal: have `handle_enroll` send a message over a `tokio::sync::oneshot`
  channel to the server task; the server task rebuilds itself with `build_tls_acceptor`
  and `serve_tls` on the same `TcpListener`.
- Option B — `ArcSwap<Option<TlsAcceptor>>`: each new TCP connection reads the
  current acceptor from shared state; enrollment updates it atomically.

**Files to touch:**
- `fleetshell-client/src-tauri/src/lib.rs` — startup wiring
- `fleetshell-client/src-tauri/src/server.rs` — `serve_tls` / hot-reload mechanism
- `fleetshell-client/src-tauri/src/portal.rs` — `handle_enroll` completion signal

---

### ~~BUG-3~~ · Portal Connect form fails for pre-enrollment / just-enrolled clients — **PARTIALLY FIXED**

**Symptom:** clicking "Connect" on the devices page immediately throws a network
error if the client has never enrolled or hasn't restarted after enrollment.

**Root cause:** `devices/+page.svelte` unconditionally fetches
`https://127-0-0-1.client.fleetshell.com:8080/api/tunnel`.  Pre-enrollment (or
post-enrollment before restart) the API server speaks plain HTTP, so the browser
rejects the HTTPS request.

**Fix options (pick one or both):**
- BUG-2 is now fixed (hot-reload TLS), so the client switches to HTTPS
  immediately after enrollment without a restart.
- [ ] Still open: the portal's Connect form should fall back to
  `http://127.0.0.1:8080/api/tunnel` for pre-enrollment clients that have
  never enrolled and therefore cannot serve HTTPS at all.

**Files to touch:**
- `fleetshell-portal/src/routes/(app)/devices/+page.svelte` — `onConnect` handler
- (optional, if BUG-2 fix chosen) — client files listed in BUG-2

---

### ~~Architecture gap~~ · HTTPS tunnels to devices with self-signed certs — **FIXED**

Browser → transparent relay → device exposed the device's self-signed cert to the
browser, causing hard blocks in modern browsers.  The fix is two-part:

**Client (`tunnel.rs`)** — when `application = "https"` and `transform = true`,
`handle_connection` now wraps the accepted `TcpStream` in a `TlsAcceptor` using
the enrolled `*.client.fleetshell.com` cert before entering `do_tunnel`.  The
browser sees the trusted wildcard cert; the gateway receives plaintext HTTP.

**Gateway (`transform.rs`)** — already injects `Host: {sni}` before the hook
runs (step 4 of the transform loop), and opens its own TLS session to the device
with cert validation disabled.  No gateway changes required.

**Usage:** set `transform = true` and `sni = "device-hostname.example.com"` in
the Connect form.  Falls back to transparent mode if the client has no cert yet.

---

## Feature work

### Portal

- [ ] LE certificate for `portal.fleetshell.com`
- [ ] Device entry form: enter machine details (IP, hostname, OS, serial, etc.)
      and persist to Redis under `systems:by-ip:<ip>`
- [ ] Service-launch buttons per device: RDP, VNC, HTTP, HTTPS
- [ ] Ability to retrieve LE certificates (ACME client / integration)
- [ ] Ability to perform LE web-based auth challenges
- [ ] Convert the welcome page into a guided multi-step enrollment page

### Client

- [x] Phase 1: persist unique client ID in AppConfig
- [x] Phase 1: placeholder CSR → portal → poll → cert + key → confirm
- [x] Phase 1: HTTPS API server — hot-reloads immediately after enrollment (no restart)
- [x] 16 loopback connection slots (127.0.0.2–127.0.0.17) via SlotManager
- [x] FunctionsView slot grid with SVG arc free/busy/countdown timers
- [x] Idle-timeout field in SettingsView (10–3600 s, saved to AppConfig)
- [x] Single-instance forwarding (HTTPS-first, HTTP fallback)
- [x] Registers protocol handler; NSIS user-level installer
- [ ] Phase 1 (BUG-1): fix probe JWT TTL / key-fetch auth (see BUG-1 above)
- [x] Phase 1 (BUG-2): hot-reload TLS after enrollment without restart — FIXED
- [ ] Phase 2: client generates its own pub/private key pair
- [ ] Phase 2: client creates CSR for `*.<uniquename>.client.fleetshell.com`
- [ ] Phase 2: client sends real PKCS#10 CSR to the portal
- [ ] Add `Connect`/`Tunnel` variant to `DeepLinkPayload` (currently portal uses
      direct HTTP POST; deep-link dispatch for tunnels not yet wired)

### Gateway

- [ ] Dockerfile — `FROM scratch` or `FROM alpine` with musl binary
- [ ] AWS infrastructure — NLB/ALB; cert for `connect.fleetshell.com` if ALB terminates TLS
- [ ] Implement concrete `TransformHook`:
      - Rewrite `Host:` header to `sni` (when present) or `target`
      - Inject auth headers if required
      - Optionally redact sensitive fields in responses
- [ ] HTTP/2 support in transform mode
- [ ] Proper upstream trust store (webpki-roots) for CA-signed deployments
- [ ] Streaming body in transform mode (currently capped at 16 MiB)

### Simulated test devices (AWS VPC)

- [ ] Windows VMs in the same VPC as the gateway
- [ ] Servers for RDP, VNC, HTTP, HTTPS (self-signed certs fine)
