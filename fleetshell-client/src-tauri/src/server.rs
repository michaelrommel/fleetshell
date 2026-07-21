/// Axum HTTP server — router, shared state, and API handlers.
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;
use tower_http::cors::CorsLayer;

/// Local port the API server binds to (127.0.0.1 only).
pub const API_PORT: u16 = 8080;

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

    log::info!(
        "Tunnel request: gateway={}:{} target={} application={} ports={:?}",
        gw_host, gw_port, req.target, req.application, ports
    );

    // ── Phase 1: pre-bind ALL listeners ──────────────────────────────────
    //
    // Every port must bind successfully before any task is spawned.
    // If one fails the Vec<TcpListener> drops (RAII), releasing the others.
    let mut listeners: Vec<(u16, tokio::net::TcpListener)> = Vec::with_capacity(ports.len());

    for &port in &ports {
        match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            Ok(l) => {
                log::info!("port {} — bound", port);
                listeners.push((port, l));
            }
            Err(e) => {
                let msg = format!("Failed to bind port {}: {}", port, e);
                log::error!("{}", msg);
                crate::util::navigate(&state.app, "logging");
                return Err((
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({ "error": msg })),
                ));
            }
        }
    }

    // ── Phase 2: launch local applications and collect URLs ───────────────
    //
    // Read config fresh so the user's latest settings are always used.
    let cfg = crate::config::load(&state.app);
    let mut urls: Vec<String> = Vec::new();
    for &port in &ports {
        let port_urls = crate::tunnel::launch_application(&req.application, port, &cfg);
        urls.extend(port_urls);
    }

    // ── Phase 3: surface the window if needed ─────────────────────────────
    if let Some(ref sk) = req.servicekey {
        log::info!("Service key present — opening Functions tab");
        crate::util::show_window(&state.app);
        state
            .app
            .emit(
                "navigate",
                serde_json::json!({ "tab": "functions", "servicekey": sk }),
            )
            .ok();
    }

    // ── Phase 4: spawn one accept-loop task per port ──────────────────────
    let bound_ports: Vec<u16> = listeners.iter().map(|(p, _)| *p).collect();

    for (port, listener) in listeners {
        let req_c   = req.clone();
        let state_c = state.clone();
        tokio::spawn(crate::tunnel::run_accept_loop(listener, port, req_c, state_c));
    }

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
