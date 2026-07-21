/// Per-connection handler.
///
/// Protocol sequence:
///
/// 1. Read the newline-terminated JSON handshake payload from the client.
/// 2. Parse it into a [`HandshakePayload`].
/// 3. Validate the JWT contained in the `token` field.
/// 4. Open a plain TCP connection to `target:port`.
/// 5. Send `200 CONNECTED\n` and enter bidirectional proxy mode, or send an
///    error status line and close.
use std::net::SocketAddr;
use std::sync::Arc;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::server::TlsStream;
use tracing::{debug, error, info, warn};

use crate::auth;
use crate::config::Config;
use crate::transform;

// ── Wire types ────────────────────────────────────────────────────────────────

/// The JSON object the client sends as the very first line after the TLS
/// handshake, terminated by `\n`.
#[derive(Debug, Deserialize)]
pub struct HandshakePayload {
    pub target:      String,
    pub application: String,
    pub port:        u16,
    pub token:       String,
    pub servicekey:  Option<String>,
    pub gateway:     String,
    pub path:        String,
    /// When `true` the gateway switches from raw byte relay to an HTTP/1.1
    /// transform proxy, allowing [`crate::transform::TransformHook`]s to
    /// inspect and modify every request and response.
    /// Absent or `false` → existing transparent `copy_bidirectional` mode.
    pub transform:   Option<bool>,
}

// ── Handler ───────────────────────────────────────────────────────────────────

/// Entry point called from the accept loop in `main`.
pub async fn handle(
    stream:     TlsStream<TcpStream>,
    peer:       SocketAddr,
    jwt_secret: Arc<String>,
    config:     Arc<Config>,
    hook:       Arc<dyn transform::TransformHook>,
) {
    info!(%peer, "connection accepted");

    let (reader_half, mut writer_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader_half);

    // ── 1. Read handshake line ───────────────────────────────────────────
    let mut raw_line = String::new();
    match reader.read_line(&mut raw_line).await {
        Ok(0) => {
            warn!(%peer, "connection closed before sending handshake");
            return;
        }
        Ok(n) => info!(%peer, bytes = n, "handshake line received"),
        Err(e) => {
            error!(%peer, "I/O error reading handshake: {e}");
            return;
        }
    }

    // ── 2. Parse JSON payload ────────────────────────────────────────────
    let payload: HandshakePayload = match serde_json::from_str(raw_line.trim()) {
        Ok(p) => p,
        Err(e) => {
            warn!(%peer, raw = %raw_line.trim(), "malformed handshake JSON: {e}");
            send_line(&mut writer_half, b"400 BAD REQUEST\n").await;
            writer_half.shutdown().await.ok();
            return;
        }
    };

    // ── 3. Log all received fields ───────────────────────────────────────
    info!(
        %peer,
        target     = %payload.target,
        application = %payload.application,
        port       = payload.port,
        gateway    = %payload.gateway,
        path       = %payload.path,
        servicekey = ?payload.servicekey,
        "handshake payload"
    );
    // Token value is intentionally not logged to avoid leaking credentials.
    info!(%peer, token_len = payload.token.len(), "JWT token received (not logged)");

    // ── 4. Validate JWT + authorise target / port ────────────────────────
    match auth::verify_connection(
        &payload.token,
        &jwt_secret,
        &payload.target,
        payload.port,
        &payload.gateway,
    ) {
        Ok(claims) => info!(
            %peer,
            sub = ?claims.sub,
            exp = ?claims.exp,
            iat = ?claims.iat,
            target = %claims.target,
            ports  = %claims.ports,
            gw     = ?claims.gw,
            "JWT verified and connection authorised"
        ),
        Err(e) => {
            // Distinguish between a bad/expired token (401) and a valid token
            // that simply does not cover this target or port (403).
            let (status, level) = match &e {
                auth::AuthError::Jwt(_) =>
                    (&b"401 UNAUTHORIZED\n"[..], tracing::Level::WARN),
                _ =>
                    (&b"403 FORBIDDEN\n"[..],     tracing::Level::WARN),
            };
            match level {
                tracing::Level::WARN => warn!(%peer, "connection rejected: {e}"),
                _                    => info!(%peer, "connection rejected: {e}"),
            }
            send_line(&mut writer_half, status).await;
            writer_half.shutdown().await.ok();
            return;
        }
    }

    // ── 5. Connect to target (before accepting, so we can report failure) ─
    let target_addr = format!("{}:{}", payload.target, payload.port);
    let mut target = match TcpStream::connect(&target_addr).await {
        Ok(s) => {
            info!(%peer, %target_addr, "connected to target");
            s
        }
        Err(e) => {
            error!(%peer, %target_addr, "failed to connect to target: {e}");
            send_line(&mut writer_half, b"502 BAD GATEWAY\n").await;
            writer_half.shutdown().await.ok();
            return;
        }
    };

    // ── 6. Accept — send 200 and start proxy ─────────────────────────────
    info!(%peer, %target_addr, "sending 200 CONNECTED — entering proxy mode");
    send_line(&mut writer_half, b"200 CONNECTED\n").await;

    // Join the BufReader + write half back into a single bidirectional
    // object.  Using tokio::io::join (rather than ReadHalf::unsplit)
    // preserves any bytes the BufReader may have read ahead past the
    // handshake line, ensuring they reach the target and are not lost.
    let mut client = tokio::io::join(reader, writer_half);

    if payload.transform.unwrap_or(false) {
        // ── Transform mode: HTTP/1.1-aware reverse proxy ──────────────────
        match payload.application.as_str() {
            "https" => {
                // Open our own TLS session to the upstream so the gateway
                // can see and transform the plaintext HTTP payload.
                match transform::connect_tls_upstream(
                    target,
                    &payload.target,
                    config.upstream_tls_accept_invalid_certs,
                )
                .await
                {
                    Ok(tls_target) => {
                        info!(%peer, %target_addr, "transform mode — TLS upstream");
                        transform::run(client, tls_target, &payload, hook).await;
                    }
                    Err(e) => {
                        error!(%peer, %target_addr, "TLS upstream connect failed: {e}");
                    }
                }
            }
            _ => {
                info!(%peer, %target_addr, "transform mode — plain upstream");
                transform::run(client, target, &payload, hook).await;
            }
        }
    } else {
        // ── Transparent mode: raw bidirectional byte relay ────────────────
        match tokio::io::copy_bidirectional(&mut client, &mut target).await {
            Ok((to_target, from_target)) => {
                info!(
                    %peer,
                    %target_addr,
                    to_target,
                    from_target,
                    "tunnel closed cleanly"
                );
            }
            Err(e) => {
                use std::io::ErrorKind::{
                    BrokenPipe, ConnectionAborted, ConnectionReset, UnexpectedEof,
                };
                // These are all normal ways a proxied connection ends: the
                // browser, target server, or client closed without a TLS
                // close_notify.  Log at DEBUG to avoid flooding the console.
                match e.kind() {
                    ConnectionReset | ConnectionAborted | BrokenPipe | UnexpectedEof => {
                        debug!(%peer, %target_addr, "tunnel ended ({})", e.kind());
                    }
                    _ => {
                        info!(%peer, %target_addr, "tunnel ended: {e}");
                    }
                }
            }
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Write `data` to `writer` and flush.  Errors are logged and swallowed —
/// a best-effort reply is all we can offer at this point.
async fn send_line<W: AsyncWriteExt + Unpin>(writer: &mut W, data: &[u8]) {
    if let Err(e) = writer.write_all(data).await {
        warn!("failed to write response: {e}");
        return;
    }
    if let Err(e) = writer.flush().await {
        warn!("failed to flush response: {e}");
    }
}
