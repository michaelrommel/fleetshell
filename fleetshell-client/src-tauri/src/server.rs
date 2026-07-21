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

// ── Request / Response types ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DeepLinkForwardRequest {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TunnelRequest {
    pub target:      String,
    /// What is being tunnelled: "http", "https", "rdp", "vnc", …
    /// This is distinct from the client↔gateway transport, which is always TLS.
    pub application: String,
    /// Comma-separated ports / ranges, e.g. "443,7000-7010"
    pub ports:       String,
    pub token:       String,
    pub servicekey:  Option<String>,
    /// Gateway address as "host" or "host:port"; port defaults to 443.
    pub gateway:     String,
    /// Optional SNI hostname to send in the TLS ClientHello when the gateway
    /// connects to the upstream target.  When absent the gateway falls back
    /// to `target`.
    pub sni:          Option<String>,
    /// When `true` the gateway switches to HTTP/1.1 transform-proxy mode
    /// instead of raw transparent forwarding.  The gateway will parse and
    /// optionally modify every HTTP request/response before relaying it.
    /// For `application = "https"` the gateway opens its own TLS connection
    /// to the upstream target.
    pub transform:   Option<bool>,
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
    let ports = crate::tunnel::parse_ports(&req.ports);
    let (gw_host, gw_port) = crate::tunnel::parse_gateway(&req.gateway);

    // Load config early — we need idle_timeout for the monitor, and vnc_viewer
    // for application launching.
    let cfg = crate::config::load(&state.app);

    log::info!(
        "Tunnel request: gateway={}:{} target={} application={} ports={:?}",
        gw_host, gw_port, req.target, req.application, ports
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

    log::info!(
        "Tunnel request: assigned slot {} ({})",
        slot.idx + 2,
        slot.ip,
    );

    // ── Phase 1: pre-bind ALL listeners on the slot IP ────────────────────
    //
    // Every port must bind successfully before any task is spawned.
    // On any failure the slot is released immediately.
    let mut listeners: Vec<(u16, tokio::net::TcpListener)> = Vec::with_capacity(ports.len());

    for &port in &ports {
        match tokio::net::TcpListener::bind((slot.ip.as_str(), port)).await {
            Ok(l) => {
                log::info!("port {} — bound on {}", port, slot.ip);
                listeners.push((port, l));
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
    for &port in &ports {
        let port_urls = crate::tunnel::launch_application(
            &req.application, port, &slot.ip, &cfg,
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
    let bound_ports: Vec<u16> = listeners.iter().map(|(p, _)| *p).collect();
    let task_handles = slot.task_handles.clone();
    let last_active  = slot.last_active.clone();

    for (port, listener) in listeners {
        let req_c      = req.clone();
        let state_c    = state.clone();
        let last_c     = last_active.clone();
        let handles_c  = task_handles.clone();

        let accept_handle = tokio::spawn(
            crate::tunnel::run_accept_loop(listener, port, req_c, state_c, last_c, handles_c),
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

/// Accept TLS connections on `listener` and serve the Axum `router` over HTTPS.
///
/// This is the TLS equivalent of `axum::serve`.  Each accepted TCP connection
/// is wrapped with `acceptor`, then served in its own tokio task via
/// hyper's auto HTTP/1+2 connection builder.
pub async fn serve_tls(
    listener: tokio::net::TcpListener,
    router:   axum::Router,
    acceptor: tokio_rustls::TlsAcceptor,
) {
    use hyper::body::Incoming;
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use hyper_util::server::conn::auto::Builder as ConnBuilder;
    use tower::ServiceExt as _;

    loop {
        let (stream, peer_addr) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e)   => { log::error!("API TLS accept error: {e}"); continue; }
        };

        let acceptor = acceptor.clone();
        let router   = router.clone();

        tokio::spawn(async move {
            let tls_stream = match acceptor.accept(stream).await {
                Ok(s)  => s,
                Err(e) => {
                    log::warn!("TLS handshake failed from {peer_addr}: {e}");
                    return;
                }
            };

            let io  = TokioIo::new(tls_stream);
            // `oneshot` consumes the cloned router and the request,
            // avoiding the need for a mutable borrow inside the closure.
            let svc = hyper::service::service_fn(move |req: hyper::Request<Incoming>| {
                router.clone().oneshot(req)
            });

            if let Err(e) = ConnBuilder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(io, svc)
                .await
            {
                log::debug!("API HTTPS connection closed ({peer_addr}): {e}");
            }
        });
    }
}
