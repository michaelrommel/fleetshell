/// Axum HTTP server — router, shared state, and API handlers.
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;
use tower_http::cors::CorsLayer;

/// Local port the API server binds to (127.0.0.1 only).
pub const API_PORT: u16 = 8080;

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
    /// Username for RDP/VNC config file injection — stored, not yet used.
    pub username:   Option<String>,
    /// Password for RDP/VNC config file injection — stored, not yet used.
    pub password:   Option<String>,
}

#[derive(Debug, Serialize)]
struct TunnelResponse {
    status: &'static str,
    /// Ports that tunnel listeners were spawned for.
    ports:  Vec<u16>,
    /// For http/https applications: URLs the caller can open directly.
    /// Empty for rdp/vnc (the local app is launched automatically).
    urls:   Vec<String>,
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
        .route("/api/deep-link",  post(deep_link_forward_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

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

    // Flatten all rows into (port, PortRow) pairs so every port carries its
    // own application / e2ecrypt / sni settings.
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

    // ── Claim a free connection slot ──────────────────────────────────────
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

    // ── Phase 1: pre-bind ALL listeners on the slot IP ────────────────────
    //
    // Every port must bind successfully before any task is spawned.
    // On any failure the slot is released immediately.
    let mut listeners: Vec<(u16, PortRow, tokio::net::TcpListener)> =
        Vec::with_capacity(flat.len());

    for (port, row) in flat {
        match tokio::net::TcpListener::bind((slot.ip.as_str(), port)).await {
            Ok(l) => {
                log::info!("port {} app={} — bound on {}", port, row.application, slot.ip);
                listeners.push((port, row, l));
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

    // ── Phase 2: launch local applications and collect URLs ───────────────
    let mut urls: Vec<String> = Vec::new();
    for (port, row, _) in &listeners {
        let port_urls = crate::tunnel::launch_application(
            &row.application, *port, &slot.ip, &cfg,
        );
        urls.extend(port_urls);
    }

    // ── Phase 3: surface the window if needed ─────────────────────────────
    if let Some(ref sk) = req.servicekey {
        log::info!("Service key present — opening Functions tab");
        crate::util::show_window(&state.app);
        state.app.emit(
            "navigate",
            serde_json::json!({ "tab": "functions", "servicekey": sk }),
        ).ok();
    }

    // ── Phase 4: notify the frontend that the slot is now active ──────────
    state.app.emit("slot-update", serde_json::json!({
        "idx":      slot.idx,
        "status":   "active",
        "progress": 1.0_f64,
    })).ok();

    // ── Phase 5: spawn one accept-loop task per port ──────────────────────
    let bound_ports: Vec<u16> = listeners.iter().map(|(p, _, _)| *p).collect();
    let task_handles = slot.task_handles.clone();
    let last_active  = slot.last_active.clone();

    for (port, row, listener) in listeners {
        let port_cfg  = crate::tunnel::PortConfig::from_request(&req, &row);
        let state_c   = state.clone();
        let last_c    = last_active.clone();
        let handles_c = task_handles.clone();

        let accept_handle = tokio::spawn(
            crate::tunnel::run_accept_loop(listener, port, port_cfg, state_c, last_c, handles_c),
        );

        // Register the accept-loop handle so release() can abort it.
        task_handles.lock().unwrap().push(accept_handle);
    }

    // ── Phase 6: start the idle monitor ───────────────────────────────────
    //
    // The monitor's handle is intentionally NOT stored in task_handles so
    // that release() does not abort it before it emits the "free" event.
    tokio::spawn(crate::slot::run_idle_monitor(
        state.app.clone(),
        slot.idx,
        last_active,
        cfg.idle_timeout,
        state.slot_manager.clone(),
    ));

    Ok((
        StatusCode::OK,
        Json(TunnelResponse {
            status: "connected",
            ports:  bound_ports,
            urls,
        }),
    ))
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
async fn serve_connection<S>(
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
