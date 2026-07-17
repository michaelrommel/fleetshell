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

#[derive(Debug, Clone, Deserialize)]
pub struct TunnelRequest {
    pub target:     String,
    pub protocol:   String,
    /// Comma-separated ports / ranges, e.g. "443,3000-3020"
    pub ports:      String,
    pub token:      String,
    pub servicekey: Option<String>,
    pub gateway:    String,
}

#[derive(Debug, Serialize)]
struct TunnelResponse {
    status: &'static str,
    /// Flat list of ports that tunnel listeners were spawned for.
    spawned_ports: Vec<u16>,
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
        .route("/api/tunnel", post(tunnel_handler))
        // Allow the Tauri WebView and any local tool to call this API.
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async fn tunnel_handler(
    State(state): State<ApiState>,
    Json(req): Json<TunnelRequest>,
) -> (StatusCode, Json<TunnelResponse>) {
    let ports = crate::tunnel::parse_ports(&req.ports);

    log::info!(
        "Tunnel request received: gateway={} target={} protocol={} ports={:?}",
        req.gateway, req.target, req.protocol, ports
    );

    // If a service key is present, switch the UI to the Functions tab immediately.
    if let Some(ref sk) = req.servicekey {
        log::info!("Service key present — navigating to Functions tab");
        state
            .app
            .emit(
                "navigate",
                serde_json::json!({ "tab": "functions", "servicekey": sk }),
            )
            .ok();
    }

    // Spawn one long-running listener task per requested port.
    for &port in &ports {
        let req_c   = req.clone();
        let state_c = state.clone();
        tokio::spawn(crate::tunnel::run_port_listener(port, req_c, state_c));
    }

    (
        StatusCode::ACCEPTED,
        Json(TunnelResponse {
            status:        "accepted",
            spawned_ports: ports,
        }),
    )
}
