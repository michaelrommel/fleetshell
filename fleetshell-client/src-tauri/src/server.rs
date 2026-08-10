/// Axum HTTP server — router, shared state, and API handlers.
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;
use tower_http::cors::CorsLayer;

/// Local port the API server binds to (127.0.0.1 only).
pub const API_PORT: u16 = 58596;

/// Hostname callers should use when speaking HTTPS to the API server.
///
/// The wildcard cert (`*.client.fleetshell.com`) covers this name, and
/// `127-0-0-1.client.fleetshell.com` is a real DNS record that resolves to
/// `127.0.0.1`, so TLS certificate validation passes without any bypass flag.
pub const API_HOST: &str = "127-0-0-1.client.fleetshell.com";

/// Default path sent to the gateway when establishing a tunnel session.
pub const DEFAULT_GATEWAY_PATH: &str = "/service/tunnel/";

/// Shared, hot-swappable TLS acceptor for the local API server.
///
/// Wrapped in `Arc<RwLock<Option<...>>>` so that enrollment (which runs in a
/// separate tokio task) can atomically promote the server from plain HTTP to
/// HTTPS without restarting it.  Stored as Tauri managed state so `portal.rs`
/// can reach it after `handle_enroll` completes.
///
/// Each new TCP connection reads the current acceptor: if `Some`, the
/// connection is wrapped in TLS; if `None`, it is served as plain HTTP.  The
/// transition takes effect for the very next accepted connection — no restart
/// needed.
///
/// Also used by `tunnel.rs` to terminate the browser's TLS connection in
/// HTTPS proxy mode (the default when `e2ecrypt` is absent or false).
pub struct TlsState(
    pub Arc<tokio::sync::RwLock<Option<tokio_rustls::TlsAcceptor>>>,
);

// ── Request / Response types ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DeepLinkForwardRequest {
    pub url: String,
}

/// Per-port connection settings sent from the portal.
/// Each row covers one port spec (single port, range, or comma list) and
/// carries its own application / guac / e2ecrypt / sni settings.
#[derive(Debug, Clone, Deserialize)]
pub struct PortRow {
    /// Comma-separated ports / ranges, e.g. "443" or "3000-3020" or "443,8080".
    pub ports:       String,
    /// Protocol the device speaks: "http" | "https" | "rdp" | "vnc".
    pub application: String,
    /// Placeholder: prefer Guacamole browser tab over launching a local app.
    /// Received and stored; not yet connected to any Guacamole integration.
    pub guac:        Option<bool>,
    /// When `true`, relay raw TLS bytes end-to-end (passthrough).
    /// When `false`/absent (default), use HTTP/1.1 proxy mode.
    pub e2ecrypt:    Option<bool>,
    /// SNI hostname for proxy-mode HTTP/S connections to the upstream device.
    pub sni:         Option<String>,
    /// URL path suffix appended when opening http/https/expert-i tabs.
    /// `None` or empty string → treated as `/` (no suffix appended).
    pub path:        Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TunnelRequest {
    pub target:     String,
    /// JWT signed by the portal; forwarded verbatim to the gateway.
    pub token:      String,
    pub servicekey: Option<String>,
    /// Gateway address as "host" or "host:port"; port defaults to 443.
    pub gateway:    String,
    /// Per-port connection settings.  One row can cover multiple ports via
    /// a range or comma list; every port in the row shares the same settings.
    pub port_rows:  Vec<PortRow>,
    /// Username for RDP/VNC credentials (from portal device database).
    pub username:   Option<String>,
    /// Password for RDP/VNC credentials (from portal device database).
    pub password:   Option<String>,
    /// Requested display width in pixels for Guacamole sessions.
    pub width:      Option<u32>,
    /// Requested display height in pixels for Guacamole sessions.
    pub height:     Option<u32>,
    /// Dots per inch for Guacamole sessions (default 96).
    pub dpi:        Option<u32>,
    /// Request drive sharing for this RDP Guacamole session.
    /// Forwarded to the gateway; ignored for VNC/SSH and when the gateway
    /// has no `GUACD_DRIVE_PATH` configured.
    pub enable_drive: Option<bool>,
    /// Request session recording for this RDP Guacamole session.
    /// Forwarded to the gateway; ignored for VNC/SSH and when the gateway
    /// has no `GUACD_RECORDING_PATH` configured.
    pub enable_record: Option<bool>,
}

#[derive(Debug, Serialize)]
struct TunnelResponse {
    status: &'static str,
    /// Ports that tunnel listeners were spawned for.
    ports:   Vec<u16>,
    /// For http/https/expert-i rows: URLs the caller can open directly.
    /// For guac rows: the wss:// WebSocket URL for the session page.
    /// Empty for rdp/vnc/ssh rows without guac (use POST /api/launch instead).
    urls:    Vec<String>,
    /// Loopback IP of the slot assigned to this tunnel (e.g. `"127.0.0.2"`).
    /// The portal passes this back to POST /api/launch when opening a native app.
    bind_ip: String,
    /// Local-port reassignments that occurred because the requested port was
    /// already in use on this machine.  Each entry is
    /// `{ requested, actual, reason }`.  The portal resolves native launch
    /// ports through this so an RDP/VNC "Open" button targets the actual port.
    remaps:  Vec<serde_json::Value>,
}

/// Request body for `POST /api/launch`.
#[derive(Debug, Deserialize)]
struct LaunchRequest {
    /// Loopback IP the tunnel was bound on (from the tunnel response `bind_ip`).
    bind_ip:     String,
    /// Port number.
    port:        u16,
    /// Application type: `"rdp"`, `"vnc"`, `"ssh"`.
    application: String,
}

/// Request body for `POST /api/probe`.
#[derive(Debug, Deserialize)]
struct ProbeRequest {
    /// Final destination IP / hostname on the gateway side.
    target:  String,
    /// Single port to test.
    port:    u16,
    /// Gateway address ("host" or "host:port").
    gateway: String,
    /// JWT authorising the probe (same token as used for the tunnel).
    token:   String,
}

/// Response body for `POST /api/probe`.
#[derive(Debug, Serialize)]
struct ProbeResponse {
    reachable: bool,
    message:   String,
}

// ── Shared state injected into every handler ──────────────────────────────────

#[derive(Clone)]
pub struct ApiState {
    pub app:          tauri::AppHandle,
    pub gateway_path: Arc<String>,
    pub slot_manager: Arc<crate::slot::SlotManager>,
}

// ── Router ────────────────────────────────────────────────────────────────────

pub fn build_router(state: ApiState) -> Router {
    Router::new()
        .route("/api/tunnel",     post(tunnel_handler))
        .route("/api/launch",      post(launch_handler))
        .route("/api/deep-link",   post(deep_link_forward_handler))
        .route("/api/show",        post(show_handler))
        .route("/api/probe",       post(probe_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/// Called by a second instance that started without a deep-link URL
/// (e.g. double-clicked from the Start Menu).  Brings the existing window
/// to the front so the user sees it, then returns 200 so the caller can exit.
async fn show_handler(State(state): State<ApiState>) -> StatusCode {
    crate::util::show_window(&state.app);
    StatusCode::OK
}

/// Asks the gateway to perform a TCP reachability check against `target:port`
/// before the portal opens a browser tab.  Lets the user know immediately
/// if a device is offline rather than waiting for the browser to time out.
async fn probe_handler(
    State(state): State<ApiState>,
    Json(req):    Json<ProbeRequest>,
) -> Json<ProbeResponse> {
    let cfg = crate::config::load(&state.app);
    log::info!(
        "Probe request: target={}:{} via {}",
        req.target, req.port, req.gateway,
    );
    match crate::tunnel::probe_target(
        &req.target,
        req.port,
        &req.gateway,
        &req.token,
        &state.gateway_path,
        cfg.gateway_skip_tls_verify,
        cfg.gateway_disable_tls,
    ).await {
        Ok(true) => {
            log::info!("Probe: {}:{} reachable", req.target, req.port);
            Json(ProbeResponse {
                reachable: true,
                message: format!("{}:{} is reachable", req.target, req.port),
            })
        }
        Ok(false) => {
            log::info!("Probe: {}:{} unreachable", req.target, req.port);
            Json(ProbeResponse {
                reachable: false,
                message: format!(
                    "{}:{} did not respond — the device is likely offline or unreachable from the gateway",
                    req.target, req.port,
                ),
            })
        }
        Err(e) => {
            log::warn!("Probe error for {}:{}: {}", req.target, req.port, e);
            Json(ProbeResponse {
                reachable: false,
                message: format!("Gateway probe failed: {e}"),
            })
        }
    }
}

/// Return the local WebSocket listener port for a guac session.
///
/// Ports below 1024 are remapped to `50000 + port` for two reasons:
///
/// 1. **OS privileges** — macOS and Linux require root to bind ports below
///    1024; the fleetshell-client runs as a normal user.
/// 2. **Browser blocking** — browsers refuse WebSocket connections to several
///    well-known low ports (22, 21, 25 …) per the Fetch spec bad-port list.
///
/// The original service port is still sent in the JSON handshake to the
/// gateway — only the local TCP listener uses the remapped port.
///
/// Examples: SSH 22 → 50022, HTTPS 443 → 50443, RDP 3389 → 3389 (unchanged).
fn guac_ws_port(service_port: u16) -> u16 {
    if service_port < 1024 {
        50000 + service_port
    } else {
        service_port
    }
}
/// Outcome of binding a slot's local TCP listener.
struct SlotBind {
    listener: tokio::net::TcpListener,
    /// Port actually bound.  Equals the requested port on the happy path; an
    /// OS-assigned ephemeral port when the requested one was already taken.
    actual:   u16,
    /// `Some` when a fallback occurred - carries a UI-facing remap notice
    /// (`{ requested, actual, reason }`).
    remap:    Option<serde_json::Value>,
}

/// Bind a local listener on `slot_ip:requested`, falling back to an OS-assigned
/// ephemeral port when the requested port is already in use.
///
/// On Windows a third-party socket bound to the wildcard address
/// `0.0.0.0:requested` shadows the whole port number across every local address,
/// so binding our loopback slot IP fails with `AddrInUse` even though nothing is
/// explicitly listening on the slot address.  The target service port travels to
/// the gateway inside the signed JWT + handshake JSON, never via this local
/// listen port, so any local port works on the wire.  We therefore surface the
/// remap to the user instead of failing the whole request.
async fn bind_slot_port(slot_ip: &str, requested: u16) -> std::io::Result<SlotBind> {
    match tokio::net::TcpListener::bind((slot_ip, requested)).await {
        Ok(listener) => Ok(SlotBind { listener, actual: requested, remap: None }),
        // Fall back on any error that means "this specific port is unavailable":
        //   * AddrInUse       (WSAEADDRINUSE / 10048) - another socket holds it.
        //   * PermissionDenied (WSAEACCES    / 10013) - Windows reserved/excluded
        //     the port (Hyper-V/WSL dynamic port ranges, exclusive-use sockets on
        //     `0.0.0.0:<port>`, or `netsh` exclusions).  This is common and does
        //     NOT surface as AddrInUse on Windows.
        Err(e) if matches!(
            e.kind(),
            std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied,
        ) => {
            let listener = tokio::net::TcpListener::bind((slot_ip, 0)).await?;
            let actual   = listener.local_addr()?.port();
            log::warn!(
                "Local port {}:{} unavailable ({}) - remapped to ephemeral {}:{}",
                slot_ip, requested, e, slot_ip, actual,
            );
            let remap = serde_json::json!({
                "requested": requested,
                "actual":    actual,
                "reason":    format!("port {} unavailable on this machine ({})", requested, e),
            });
            Ok(SlotBind { listener, actual, remap: Some(remap) })
        }
        Err(e) => Err(e),
    }
}

type HandlerResult = Result<
    (StatusCode, Json<TunnelResponse>),
    (StatusCode, Json<serde_json::Value>),
>;

async fn tunnel_handler(
    State(state): State<ApiState>,
    Json(req): Json<TunnelRequest>,
) -> HandlerResult {
    let (gw_host, gw_port) = crate::tunnel::parse_gateway(&req.gateway);

    // Load config early — needed for idle_timeout and vnc_viewer path.
    let cfg = crate::config::load(&state.app);

    if req.port_rows.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "port_rows must not be empty" })),
        ));
    }

    // Flatten all rows into (port, PortRow) pairs.
    let mut flat: Vec<(u16, PortRow)> = Vec::new();
    for row in &req.port_rows {
        for port in crate::tunnel::parse_ports(&row.ports) {
            flat.push((port, row.clone()));
        }
    }

    if flat.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "no valid ports found in port_rows" })),
        ));
    }

    log::info!(
        "Tunnel request: gateway={}:{} target={} ports={:?}",
        gw_host, gw_port, req.target,
        flat.iter().map(|(p, _)| *p).collect::<Vec<_>>(),
    );

    // Three-way partition:
    //  guac_flat    — guac:true                          → Guacamole canvas
    //  ssh_flat     — application:"ssh", e2ecrypt:false  → xterm.js WebSocket
    //  regular_flat — everything else incl. ssh+e2ecrypt → raw TCP tunnel
    let (guac_flat, rest): (Vec<_>, Vec<_>) = flat
        .into_iter()
        .partition(|(_, r)| r.guac.unwrap_or(false));

    let (ssh_flat, regular_flat): (Vec<_>, Vec<_>) = rest
        .into_iter()
        .partition(|(_, r)| {
            r.application.eq_ignore_ascii_case("ssh")
                && !r.e2ecrypt.unwrap_or(false)
        });

    let mut all_ports: Vec<u16>   = Vec::new();
    let mut all_urls:  Vec<String> = Vec::new();
    let mut all_remaps: Vec<serde_json::Value> = Vec::new(); // requested->actual reassignments
    let mut bind_ip = String::new(); // used by POST /api/launch for native apps

    // ── Guacamole rows (first one; multiple guac rows not yet supported) ──
    if let Some((port, row)) = guac_flat.into_iter().next() {
        let ws_port = guac_ws_port(port);

        let slot = match state.slot_manager.claim().await {
            Some(s) => s,
            None => {
                let msg = "All 16 connection slots are in use".to_string();
                log::error!("{}", msg);
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({ "error": msg })),
                ));
            }
        };

        let slot_idx     = slot.idx;
        let slot_ip      = slot.ip.clone();
        let last_active  = slot.last_active.clone();
        let task_handles = slot.task_handles.clone();

        let bound = match bind_slot_port(&slot_ip, ws_port).await {
            Ok(b)  => b,
            Err(e) => {
                let msg = format!("Failed to bind {}:{}: {}", slot_ip, ws_port, e);
                log::error!("{}", msg);
                state.slot_manager.release(slot_idx).await;
                crate::util::navigate(&state.app, "logging");
                return Err((
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({ "error": msg })),
                ));
            }
        };
        let listener = bound.listener;
        let ws_port  = bound.actual; // shadow with the port actually bound
        let remaps: Vec<serde_json::Value> = bound.remap.into_iter().collect();
        all_remaps.extend(remaps.iter().cloned());

        let params = std::sync::Arc::new(crate::guac_proxy::GuacSessionParams {
            target:      req.target.clone(),
            port,
            ws_port,
            token:       req.token.clone(),
            protocol:    row.application.clone(),
            username:    req.username.clone().unwrap_or_default(),
            password:    req.password.clone().unwrap_or_default(),
            width:       req.width.unwrap_or(1280),
            height:      req.height.unwrap_or(800),
            dpi:         req.dpi.unwrap_or(96),
            gateway:     req.gateway.clone(),
            slot_idx,
            last_active: last_active.clone(),
            enable_drive:    req.enable_drive.unwrap_or(false),
            enable_record:   req.enable_record.unwrap_or(false),
            skip_tls_verify: cfg.gateway_skip_tls_verify,
            disable_tls:     cfg.gateway_disable_tls,
        });

        let handle = tokio::spawn(
            crate::guac_proxy::run_guac_slot(listener, params, state.clone())
        );
        task_handles.lock().unwrap().push(handle);

        state.app.emit("slot-update", serde_json::json!({
            "idx": slot_idx, "status": "active", "progress": 1.0,
            "remaps": remaps,
        })).ok();

        tokio::spawn(crate::slot::run_idle_monitor(
            state.app.clone(), slot_idx, last_active,
            cfg.idle_timeout, state.slot_manager.clone(),
        ));

        let ws_url = format!(
            "wss://{}:{}/guac-ws",
            crate::tunnel::dns_host(&slot_ip), ws_port,
        );
        log::info!(
            "Guacamole session created - slot {} ({}) port {} (ws:{}) - {}",
            slot_idx, slot_ip, port, ws_port, ws_url,
        );

        all_ports.push(port);
        all_urls.push(ws_url);
        bind_ip = slot_ip;
    }

    // ── SSH direct rows (application:"ssh", guac:false) ───────────────────
    // Each SSH row gets its own slot and a WebSocket listener at /ssh-ws.
    // The browser xterm.js session connects to that URL; the proxy bridges
    // framed bytes to the gateway which speaks SSH natively.
    if let Some((port, _row)) = ssh_flat.into_iter().next() {
        let ws_port = guac_ws_port(port); // remap privileged ports (22 → 50022)

        let slot = match state.slot_manager.claim().await {
            Some(s) => s,
            None => {
                let msg = "All 16 connection slots are in use".to_string();
                log::error!("{}", msg);
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({ "error": msg })),
                ));
            }
        };

        let slot_idx     = slot.idx;
        let slot_ip      = slot.ip.clone();
        let last_active  = slot.last_active.clone();
        let task_handles = slot.task_handles.clone();

        let bound = match bind_slot_port(&slot_ip, ws_port).await {
            Ok(b)  => b,
            Err(e) => {
                let msg = format!("Failed to bind {}:{}: {}", slot_ip, ws_port, e);
                log::error!("{}", msg);
                state.slot_manager.release(slot_idx).await;
                crate::util::navigate(&state.app, "logging");
                return Err((
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({ "error": msg })),
                ));
            }
        };
        let listener = bound.listener;
        let ws_port  = bound.actual; // shadow with the port actually bound
        let remaps: Vec<serde_json::Value> = bound.remap.into_iter().collect();
        all_remaps.extend(remaps.iter().cloned());

        let params = std::sync::Arc::new(crate::ssh_proxy::SshProxyParams {
            target:          req.target.clone(),
            port,
            ws_port,
            token:           req.token.clone(),
            username:        req.username.clone().unwrap_or_default(),
            password:        req.password.clone().unwrap_or_default(),
            width:           req.width.unwrap_or(1920),
            height:          req.height.unwrap_or(1080),
            gateway:         req.gateway.clone(),
            slot_idx,
            last_active:     last_active.clone(),
            skip_tls_verify: cfg.gateway_skip_tls_verify,
            disable_tls:     cfg.gateway_disable_tls,
        });

        let handle = tokio::spawn(
            crate::ssh_proxy::run_ssh_slot(listener, params, state.clone())
        );
        task_handles.lock().unwrap().push(handle);

        state.app.emit("slot-update", serde_json::json!({
            "idx": slot_idx, "status": "active", "progress": 1.0,
            "remaps": remaps,
        })).ok();

        tokio::spawn(crate::slot::run_idle_monitor(
            state.app.clone(), slot_idx, last_active,
            cfg.idle_timeout, state.slot_manager.clone(),
        ));

        let ws_url = format!(
            "wss://{}:{}/ssh-ws",
            crate::tunnel::dns_host(&slot_ip), ws_port,
        );
        log::info!(
            "SSH direct session created - slot {} ({}) port {} (ws:{}) - {}",
            slot_idx, slot_ip, port, ws_port, ws_url,
        );

        all_ports.push(port);
        all_urls.push(ws_url);
        bind_ip = slot_ip;
    }


    // ── Regular TCP-tunnel rows ───────────────────────────────────────────
    if !regular_flat.is_empty() {
        let slot = match state.slot_manager.claim().await {
            Some(s) => s,
            None => {
                let msg = "All 16 connection slots are in use".to_string();
                log::error!("{}", msg);
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({ "error": msg })),
                ));
            }
        };

        log::info!("Tunnel request: assigned slot {} ({})", slot.idx + 2, slot.ip);

        // Phase 1: pre-bind ALL listeners before spawning any tasks.
        // Each entry is (local_port, target_port, row, listener).  The two ports
        // differ only when the requested port was already in use locally and we
        // fell back to an ephemeral one; only target_port reaches the gateway.
        let mut listeners: Vec<(u16, u16, PortRow, tokio::net::TcpListener)> =
            Vec::with_capacity(regular_flat.len());
        let mut remaps: Vec<serde_json::Value> = Vec::new();

        for (port, row) in regular_flat {
            match bind_slot_port(&slot.ip, port).await {
                Ok(bound) => {
                    let local_port = bound.actual;
                    if let Some(r) = bound.remap { remaps.push(r); }
                    log::info!(
                        "target port {} app={} - bound on {}:{}",
                        port, row.application, slot.ip, local_port,
                    );
                    listeners.push((local_port, port, row, bound.listener));
                }
                Err(e) => {
                    let msg = format!("Failed to bind {}:{}: {}", slot.ip, port, e);
                    log::error!("{}", msg);
                    state.slot_manager.release(slot.idx).await;
                    crate::util::navigate(&state.app, "logging");
                    return Err((
                        StatusCode::CONFLICT,
                        Json(serde_json::json!({ "error": msg })),
                    ));
                }
            }
        }

        // Phase 2: collect browser URLs (native apps are launched on demand).
        // The browser / native app connects to the LOCAL port, so URLs and the
        // returned ports use local_port, not the target port.
        for (local_port, _target_port, row, _) in &listeners {
            if let Some(url) = crate::tunnel::get_tunnel_url(
                    &row.application, *local_port, &slot.ip,
                    row.path.as_deref().unwrap_or(""),
                ) {
                all_urls.push(url);
            }
        }

        all_ports.extend(listeners.iter().map(|(local_port, _, _, _)| *local_port));
        all_remaps.extend(remaps.iter().cloned());
        bind_ip = slot.ip.clone();

        // Phase 3: servicekey notification.
        if let Some(ref sk) = req.servicekey {
            log::info!("Service key present — notifying Functions tab");
            state.app.emit(
                "navigate",
                serde_json::json!({ "tab": "functions", "servicekey": sk }),
            ).ok();
        }

        // Phase 4: slot-update.
        state.app.emit("slot-update", serde_json::json!({
            "idx":      slot.idx,
            "status":   "active",
            "progress": 1.0_f64,
            "remaps":   remaps,
        })).ok();

        // Phase 5: spawn one accept-loop task per port.
        let task_handles = slot.task_handles.clone();
        let last_active  = slot.last_active.clone();

        for (local_port, target_port, row, listener) in listeners {
            let port_cfg  = crate::tunnel::PortConfig::from_request(&req, &row);
            let state_c   = state.clone();
            let last_c    = last_active.clone();
            let handles_c = task_handles.clone();

            let accept_handle = tokio::spawn(
                crate::tunnel::run_accept_loop(
                    listener, local_port, target_port, port_cfg, state_c, last_c, handles_c,
                ),
            );
            task_handles.lock().unwrap().push(accept_handle);
        }

        // Phase 6: idle monitor.
        tokio::spawn(crate::slot::run_idle_monitor(
            state.app.clone(), slot.idx, last_active,
            cfg.idle_timeout, state.slot_manager.clone(),
        ));
    }

    Ok((
        StatusCode::OK,
        Json(TunnelResponse {
            status:  "connected",
            ports:   all_ports,
            urls:    all_urls,
            bind_ip,
            remaps:  all_remaps,
        }),
    ))
}

/// Launch a native application for an already-established tunnel.
///
/// Called by the portal when the user explicitly clicks an Open button in
/// the connection result box.  The `bind_ip` from the tunnel response tells
/// us which slot IP the listener is bound on.
async fn launch_handler(
    State(state): State<ApiState>,
    Json(req):    Json<LaunchRequest>,
) -> StatusCode {
    log::info!(
        "Launch request: application={} bind_ip={} port={}",
        req.application, req.bind_ip, req.port,
    );
    let cfg = crate::config::load(&state.app);
    crate::tunnel::launch_native(&req.application, req.port, &req.bind_ip, &cfg);
    StatusCode::OK
}

/// Receives a `fleetshell://` URL forwarded from a second instance that found
/// this server already running.  Dispatches it into the normal deep-link flow.
async fn deep_link_forward_handler(
    State(state): State<ApiState>,
    Json(req): Json<DeepLinkForwardRequest>,
) -> StatusCode {
    log::info!("Deep-link forwarded from second instance: {}", req.url);
    match req.url.parse::<url::Url>() {
        Ok(url) => {
            let app = state.app.clone();
            tauri::async_runtime::spawn(async move {
                crate::portal::handle_deep_link(&app, url).await;
            });
            StatusCode::OK
        }
        Err(e) => {
            log::error!("Deep-link forward: invalid URL '{}': {}", req.url, e);
            StatusCode::BAD_REQUEST
        }
    }
}

// ── HTTPS server ─────────────────────────────────────────────────────────────

/// Parse a PEM certificate chain and a PEM private key into a TLS acceptor
/// that can be used to serve the Axum router over HTTPS.
///
/// `cert_pem` must contain the full chain (leaf first).  `key_pem` may be
/// PKCS#8 (`-----BEGIN PRIVATE KEY-----`) or SEC1 (`-----BEGIN EC PRIVATE
/// KEY-----`).
pub fn build_tls_acceptor(
    cert_pem: &str,
    key_pem:  &str,
) -> Result<tokio_rustls::TlsAcceptor, String> {
    use rustls::pki_types::CertificateDer;

    let certs: Vec<CertificateDer<'static>> =
        rustls_pemfile::certs(&mut std::io::BufReader::new(cert_pem.as_bytes()))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("PEM cert parse error: {e}"))?;

    if certs.is_empty() {
        return Err("No certificates found in PEM data".to_string());
    }

    let key = rustls_pemfile::private_key(
        &mut std::io::BufReader::new(key_pem.as_bytes()),
    )
    .map_err(|e| format!("PEM key parse error: {e}"))?
    .ok_or_else(|| "No private key found in PEM data".to_string())?;

    // Use the ring provider explicitly — same as the outbound TLS in tunnel.rs.
    let server_config = rustls::ServerConfig::builder_with_provider(
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("TLS protocol config: {e}"))?
    .with_no_client_auth()
    .with_single_cert(certs, key)
    .map_err(|e| format!("TLS server config: {e}"))?;

    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(server_config)))
}

/// Accept connections on `listener` and serve `router`, upgrading each new
/// connection to TLS if `tls` currently holds an acceptor, or serving plain
/// HTTP otherwise.
///
/// The TLS state is sampled **per accepted connection**, so writing a new
/// [`tokio_rustls::TlsAcceptor`] into `tls` after enrollment takes effect
/// immediately — no restart required.
pub async fn serve_adaptive(
    listener: tokio::net::TcpListener,
    router:   axum::Router,
    tls:      Arc<tokio::sync::RwLock<Option<tokio_rustls::TlsAcceptor>>>,
) {
    loop {
        let (stream, peer_addr) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e)   => { log::error!("API accept error: {e}"); continue; }
        };

        // Sample the current TLS state.  TlsAcceptor is Arc<ServerConfig>
        // internally, so cloning is cheap.
        let acceptor_opt = tls.read().await.clone();
        let router = router.clone();

        match acceptor_opt {
            Some(acceptor) => {
                tokio::spawn(async move {
                    match acceptor.accept(stream).await {
                        Ok(s)  => serve_connection(
                            hyper_util::rt::TokioIo::new(s), router, peer_addr,
                        ).await,
                        Err(e) => log::warn!("API TLS handshake failed from {peer_addr}: {e}"),
                    }
                });
            }
            None => {
                tokio::spawn(async move {
                    serve_connection(
                        hyper_util::rt::TokioIo::new(stream), router, peer_addr,
                    ).await;
                });
            }
        }
    }
}

/// Serve one HTTP/1+2 connection to completion.
///
/// Generic over the I/O stream type so the same code path handles both plain
/// TCP and TLS streams without boxing.
pub(crate) async fn serve_connection<S>(
    io:        hyper_util::rt::TokioIo<S>,
    router:    axum::Router,
    peer_addr: std::net::SocketAddr,
)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use hyper::body::Incoming;
    use hyper_util::rt::TokioExecutor;
    use hyper_util::server::conn::auto::Builder as ConnBuilder;
    use tower::ServiceExt as _;

    let svc = hyper::service::service_fn(move |req: hyper::Request<Incoming>| {
        router.clone().oneshot(req)
    });
    if let Err(e) = ConnBuilder::new(TokioExecutor::new())
        .serve_connection_with_upgrades(io, svc)
        .await
    {
        log::debug!("API connection closed ({peer_addr}): {e}");
    }
}
