/// Per-port TCP listeners and gateway tunnel sessions.
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

use crate::server::{ApiState, TunnelRequest};

// ── Port-spec parser ──────────────────────────────────────────────────────────

/// Parse a port specification like `"443,3000-3020"` into a flat `Vec<u16>`.
///
/// Individual ports and inclusive ranges (`start-end`) can be mixed freely.
/// Invalid tokens are skipped with a warning.
pub fn parse_ports(spec: &str) -> Vec<u16> {
    let mut ports = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((start, end)) = part.split_once('-') {
            match (start.trim().parse::<u16>(), end.trim().parse::<u16>()) {
                (Ok(s), Ok(e)) if s <= e => ports.extend(s..=e),
                _ => log::warn!("Ignoring invalid port range: '{}'", part),
            }
        } else {
            match part.parse::<u16>() {
                Ok(p)  => ports.push(p),
                Err(_) => log::warn!("Ignoring invalid port: '{}'", part),
            }
        }
    }
    ports
}

// ── TLS helper ────────────────────────────────────────────────────────────────

/// Build a rustls TLS connector backed by Mozilla's root CA bundle.
fn make_tls_connector() -> Result<TlsConnector, Box<dyn std::error::Error + Send + Sync>> {
    let root_store = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

// ── Per-port listener ─────────────────────────────────────────────────────────

/// Bind `0.0.0.0:{port}` and loop, spawning a `handle_connection` task for
/// every accepted local TCP connection.
pub async fn run_port_listener(port: u16, req: TunnelRequest, state: ApiState) {
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l)  => l,
        Err(e) => {
            log::error!("port {} — failed to bind listener: {}", port, e);
            state.app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
            return;
        }
    };

    log::info!("port {} — tunnel listener ready", port);

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                log::debug!("port {} — accepted connection from {}", port, peer);
                let req_c   = req.clone();
                let state_c = state.clone();
                tokio::spawn(handle_connection(stream, port, req_c, state_c));
            }
            Err(e) => {
                log::error!("port {} — accept error: {}", port, e);
                // Brief pause to avoid a tight error loop before retrying.
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

// ── Per-connection handler ────────────────────────────────────────────────────

async fn handle_connection(local: TcpStream, port: u16, req: TunnelRequest, state: ApiState) {
    let gw_port = match req.protocol.as_str() {
        "https" | "wss" => 443u16,
        "http"  | "ws"  => 80u16,
        other           => {
            log::warn!("port {} — unknown protocol '{}', defaulting to 443", port, other);
            443
        }
    };

    let gw_addr = format!("{}:{}", req.gateway, gw_port);
    log::debug!("port {} — connecting to gateway {}", port, gw_addr);

    let tcp = match TcpStream::connect(&gw_addr).await {
        Ok(s)  => s,
        Err(e) => {
            log::error!("port {} — gateway connect failed ({}): {}", port, gw_addr, e);
            state.app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
            return;
        }
    };

    let payload = build_payload(&req, port, &state.gateway_path);

    match req.protocol.as_str() {
        "https" | "wss" => {
            let connector = match make_tls_connector() {
                Ok(c)  => c,
                Err(e) => {
                    log::error!("port {} — TLS setup failed: {}", port, e);
                    state.app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
                    return;
                }
            };
            let server_name = match rustls::pki_types::ServerName::try_from(req.gateway.as_str()) {
                Ok(n)  => n.to_owned(),
                Err(e) => {
                    log::error!("port {} — invalid gateway hostname '{}': {}", port, req.gateway, e);
                    state.app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
                    return;
                }
            };
            match connector.connect(server_name, tcp).await {
                Ok(tls) => do_tunnel(local, tls, &payload, port, &state.app).await,
                Err(e)  => {
                    log::error!("port {} — TLS handshake failed: {}", port, e);
                    state.app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
                }
            }
        }
        _ => do_tunnel(local, tcp, &payload, port, &state.app).await,
    }
}

// ── Handshake + bidirectional forwarding ──────────────────────────────────────

/// Build the JSON payload that is sent to the gateway on first connect.
///
/// Includes the specific `port` being tunnelled so the gateway can route
/// to the right backend service.
fn build_payload(req: &TunnelRequest, port: u16, gateway_path: &str) -> Vec<u8> {
    let json = serde_json::json!({
        "target":     req.target,
        "protocol":   req.protocol,
        "port":       port,
        "token":      req.token,
        "servicekey": req.servicekey,
        "gateway":    req.gateway,
        "path":       gateway_path,
    });
    let mut bytes = json.to_string().into_bytes();
    bytes.push(b'\n');
    bytes
}

/// Send the JSON payload, read the gateway's single-line response, check for
/// `"200 CONNECTED"`, then hand off to `tokio::io::copy_bidirectional`.
async fn do_tunnel<S>(
    mut local:   TcpStream,
    mut gateway: S,
    payload:     &[u8],
    port:        u16,
    app:         &tauri::AppHandle,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    // ── Send the JSON payload ────────────────────────────────────────────
    if let Err(e) = gateway.write_all(payload).await {
        log::error!("port {} — payload write failed: {}", port, e);
        app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
        return;
    }
    if let Err(e) = gateway.flush().await {
        log::error!("port {} — flush failed: {}", port, e);
        app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
        return;
    }

    // ── Read single-line response from the gateway ───────────────────────
    let response = match read_line(&mut gateway, 1024).await {
        Ok(r)  => r,
        Err(e) => {
            log::error!("port {} — failed to read gateway response: {}", port, e);
            app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
            return;
        }
    };
    let response = response.trim().to_string();
    log::info!("port {} — gateway: '{}'", port, response);

    // ── Validate "200 CONNECTED" ─────────────────────────────────────────
    let upper = response.to_uppercase();
    if !upper.starts_with("200") || !upper.contains("CONNECTED") {
        log::error!("port {} — gateway refused tunnel: '{}'", port, response);
        app.emit("navigate", serde_json::json!({ "tab": "logging" })).ok();
        return;
    }

    log::info!("port {} — tunnel established, forwarding data", port);

    // ── Bidirectional data forwarding ────────────────────────────────────
    match tokio::io::copy_bidirectional(&mut local, &mut gateway).await {
        Ok((to_gw, from_gw)) => {
            log::info!(
                "port {} — tunnel closed (→gw {} B, ←gw {} B)",
                port, to_gw, from_gw
            );
        }
        Err(e) => {
            log::debug!("port {} — tunnel error: {}", port, e);
        }
    }
}

/// Read bytes from `reader` until `\n` or EOF, up to `max_bytes`.
/// Returns the line without the trailing newline.
async fn read_line<R: AsyncRead + Unpin>(
    reader:    &mut R,
    max_bytes: usize,
) -> std::io::Result<String> {
    let mut buf  = Vec::with_capacity(64);
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte).await? {
            0 => break,              // EOF
            _ => {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0]);
                if buf.len() >= max_bytes {
                    break;
                }
            }
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}
