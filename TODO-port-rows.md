# Port-rows refactor — incremental plan

## Goal
Replace the flat `application/ports/sni/e2ecrypt` fields in the tunnel request
with a `port_rows` array so each port range can have independent settings.

## New JSON wire format (portal → client)

```json
{
  "target":     "192.168.1.100",
  "token":      "<jwt>",
  "gateway":    "gateway.fleetshell.com",
  "servicekey": "...",
  "username":   "administrator",
  "password":   "secret",
  "port_rows": [
    { "ports": "443",       "application": "https", "guac": false, "e2ecrypt": false, "sni": "device.example.com" },
    { "ports": "3389",      "application": "rdp",   "guac": false, "e2ecrypt": false, "sni": "" }
  ]
}
```

JWT signing still uses all ports flattened: `allPorts = rows.map(r => r.ports).join(',')`.

The gateway handshake wire format is UNCHANGED (per-connection JSON with single port).

## Steps

- [x] Step 0: Write this plan
- [x] Step 1: `server.rs` — add `PortRow` struct, rewrite `TunnelRequest`, update `tunnel_handler`
- [x] Step 2: `tunnel.rs` — add `PortConfig`, update `run_accept_loop` / `handle_connection` / `build_payload`
          Test: `cargo build -p fleetshell-client` must succeed
- [x] Step 3: Portal `+page.svelte` — new form UI (port rows table) + new JSON body
          Test: open /devices in browser, verify form renders and sends correct JSON

## Key design notes

- `PortConfig` (in tunnel.rs) is the per-port internal type; constructed from
  `(TunnelRequest, PortRow)` in server.rs before spawning accept loops.
- `guac` and `username`/`password` are received and stored but NOT yet acted on.
- `sni` is visually dimmed in the UI when application=rdp/vnc or e2ecrypt=true.
- Portal form: Target+Gateway in a 2-col grid; port-rows table full-width;
  Servicekey full-width; Username+Password in a 2-col grid.
