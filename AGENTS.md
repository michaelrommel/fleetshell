# FleetShell — Architecture Overview for Agent Handoff

This document is written for an agent that will implement `fleetshell-gateway/`.
It describes the repository layout, the client's behaviour, and the exact
wire protocol the gateway must speak.

---

## Repository layout

```
fleetshell/
├── Cargo.toml                  # Cargo workspace (resolver = "2")
├── Cargo.lock
├── .cargo/config.toml          # Cross-compile: x86_64-pc-windows-gnu via MinGW posix-threads
├── scripts/
│   └── build-windows-x64.sh   # Cross-compile helper (--installer flag for NSIS)
├── fleetshell-client/          # Tauri desktop application (the existing component)
│   ├── src/                    # SvelteKit + TypeScript frontend
│   └── src-tauri/              # Rust/Tauri backend
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs          # Tauri setup, tray icon, axum server spawn
│           ├── server.rs       # Axum router + TunnelRequest handler
│           └── tunnel.rs       # Port-spec parser, TCP listeners, gateway sessions
└── fleetshell-gateway/         # ← TO BE IMPLEMENTED by the receiving agent
```

The workspace currently has one member: `fleetshell-client/src-tauri`.
Add `fleetshell-gateway` as a second workspace member.

---

## fleetshell-client — what it does

The client is a **Tauri 2 desktop application** (SvelteKit + Svelte 5 frontend,
Rust backend) that starts minimised to the system tray.

### Embedded API server

On startup the client binds an **axum HTTP server on `127.0.0.1:8080`**.
This is a local control plane — it is not exposed to the network.

#### `POST /api/tunnel`

Accepts `Content-Type: application/json`:

```json
{
    "target":     "192.168.13.133",
    "protocol":   "https",
    "ports":      "443,3000-3020",
    "token":      "jsonwebtoken-hashbased",
    "servicekey": "abcde-fghij-klmno-pqrst-vwxyz-12345-67890",
    "gateway":    "atlanta-01"
}
```

| Field        | Type            | Notes                                              |
|--------------|-----------------|----------------------------------------------------|
| `target`     | string          | Final destination host the gateway must reach      |
| `protocol`   | `"https"\|"http"\|"wss"\|"ws"` | Determines TLS and default port   |
| `ports`      | string          | Comma-separated ports/ranges: `"443,3000-3020"`    |
| `token`      | string          | JWT used for gateway authentication                |
| `servicekey` | string (optional) | If present, displayed in the client UI           |
| `gateway`    | string          | Gateway hostname (e.g. `"atlanta-01"`)             |

**Response:** `202 Accepted`
```json
{ "status": "accepted", "spawned_ports": [443, 3000, 3001, ..., 3020] }
```

The handler returns immediately. All tunnel work happens asynchronously.

### Tunnel lifecycle (one per port)

For every port `P` in the parsed port list the client:

1. **Binds** `TcpListener` on `0.0.0.0:P`.
2. **Loops** accepting local TCP connections.
3. For **each accepted connection** spawns a task that:
   a. Connects TCP to `{gateway}:{443 for https/wss, 80 for http/ws}`.
   b. If `protocol` is `https`/`wss` upgrades to TLS (rustls + Mozilla root CAs).
   c. Sends the **handshake payload** (see below) and waits for one response line.
   d. On `"200 CONNECTED"` → enters **bidirectional forwarding** via
      `tokio::io::copy_bidirectional` between the local socket and the gateway socket.
   e. On any other response or error → logs the error and emits a Tauri UI event
      to open the Logging tab.

### Handshake payload (client → gateway)

A single UTF-8 JSON object followed by a newline (`\n`):

```json
{
    "target":     "192.168.13.133",
    "protocol":   "https",
    "port":       443,
    "token":      "jsonwebtoken-hashbased",
    "servicekey": "abcde-fghij-klmno-pqrst-vwxyz-12345-67890",
    "gateway":    "atlanta-01",
    "path":       "/service/tunnel/"
}
```

> `port` is the **single port** for this session (expanded from the range).  
> `path` is a config variable on the client, defaulting to `"/service/tunnel/"`.

### Handshake response (gateway → client)

A single UTF-8 line terminated by `\n`.

| Response line      | Client action                                              |
|--------------------|------------------------------------------------------------|
| starts with `200` **and** contains `CONNECTED` (case-insensitive) | Enter `copy_bidirectional` mode |
| anything else      | Log error, emit UI navigate event `{ tab: "logging" }`, close connection |

The simplest valid accept response is therefore:

```
200 CONNECTED\n
```

After that line is sent the connection is a **raw byte pipe** — no further
framing. The gateway must relay bytes between this socket and the backend
(`target:port`) without any additional protocol overhead.

### UI events emitted by the client (Tauri events)

The Rust backend emits these events to the SvelteKit frontend via
`AppHandle::emit`:

| Event name | Payload | Trigger |
|------------|---------|---------|
| `"navigate"` | `{ "tab": "functions", "servicekey": "..." }` | `servicekey` field present in tunnel request |
| `"navigate"` | `{ "tab": "logging" }` | Any tunnel error (bind failure, connect failure, bad response) |

---

## fleetshell-gateway — what to implement

The gateway is a **standalone Rust binary** that:

1. **Listens** for incoming TCP connections from clients (on port 443 for HTTPS
   deployments, or a configurable port).
2. For each connection, reads the **handshake payload** (newline-terminated JSON,
   described above).
3. **Authenticates** the connection using the `token` field (JWT verification).
4. If authentication succeeds:
   - Responds with `200 CONNECTED\n`.
   - Opens a new TCP connection to `target:port`.
   - Runs `copy_bidirectional` between the client socket and the target socket.
5. If authentication fails or the payload is invalid:
   - Responds with an error line (e.g. `401 UNAUTHORIZED\n`).
   - Closes the connection.

### Suggested tech stack (consistent with the client)

- **Runtime:** `tokio` (same major version as the workspace: `1.x`)
- **TLS termination:** `tokio-rustls` with `rustls-acme` or pre-provisioned certs
- **JWT verification:** `jsonwebtoken` crate
- **Logging:** `tracing` or the `log` crate (consistent with the rest of the workspace)
- **Config:** environment variables or a TOML config file (`config` crate)

### Workspace integration

Add to the root `Cargo.toml`:

```toml
members = [
    "fleetshell-client/src-tauri",
    "fleetshell-gateway",
]
```

Create `fleetshell-gateway/Cargo.toml` with `[[bin]] name = "fleetshell-gateway"`.

### Key design constraints

- The wire protocol is **intentionally minimal**: one JSON line in, one status
  line out, then raw bytes. Do not add HTTP framing or length-prefixing — the
  client does not speak it.
- The gateway must handle **many concurrent tunnels** (one tokio task per
  active connection is the natural fit).
- The `path` field in the payload (`"/service/tunnel/"`) is informational for
  now — the gateway can use it for routing to multiple backend services in the
  future, but for the first implementation a single listener is sufficient.
- The `servicekey` field is opaque to the gateway; it is passed through in the
  payload purely so the client can display it in its UI.

---

## Sequence diagram

```
 Local app          fleetshell-client             fleetshell-gateway        target host
     |                     |                              |                      |
     |--TCP connect------->|                              |                      |
     |  (port P)           |--TCP/TLS connect------------>|                      |
     |                     |--JSON payload + \n---------->|                      |
     |                     |                              |--verify token        |
     |                     |<--"200 CONNECTED\n"----------|                      |
     |                     |                              |--TCP connect-------->|
     |<===========raw bytes (copy_bidirectional)==========><=====raw bytes======>|
     |                     |                              |                      |
```

---

## What is NOT yet implemented (future work)

- Gateway TLS certificate management (ACME / Let's Encrypt)
- JWT signing key distribution between client and gateway
- Session tracking / active tunnel dashboard in the client UI
- Graceful shutdown of tunnel listeners when the client closes
- Per-port access-control policies on the gateway
- `fleetshell-gateway` Dockerfile / systemd unit
