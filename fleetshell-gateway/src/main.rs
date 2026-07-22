/// fleetshell-gateway — TLS TCP tunnel gateway with JWT authentication.
///
/// # Wire protocol
///
/// The client opens a TLS TCP connection and immediately sends a
/// newline-terminated JSON handshake:
///
/// ```json
/// {"target":"192.168.1.10","protocol":"https","port":443,
///  "token":"<jwt>","servicekey":"...","gateway":"atlanta-01","path":"/service/tunnel/"}
/// ```
///
/// The gateway validates the JWT and responds with a single status line:
///
/// | Response          | Meaning                              |
/// |-------------------|--------------------------------------|
/// | `200 CONNECTED\n` | Token OK — enter bidirectional proxy |
/// | `400 BAD REQUEST\n` | Unparseable JSON                   |
/// | `401 UNAUTHORIZED\n` | Invalid / expired JWT             |
///
/// After `200 CONNECTED` the connection becomes a raw byte pipe between the
/// client and the backend target host.  Bidirectional proxy is scaffolded in
/// `handler.rs` and will be wired up in the next implementation step.
///
/// # Configuration (environment variables)
///
/// | Variable              | Default          | Description                     |
/// |-----------------------|------------------|---------------------------------|
/// | `GATEWAY_LISTEN_ADDR` | `0.0.0.0:8443`   | TCP listen address              |
/// | `JWT_SECRET`          | *(dev default)*  | HMAC-SHA256 signing secret      |
/// | `TLS_CERT_FILE`       | *(none)*         | PEM cert chain (when `GATEWAY_TLS=true`) |
/// | `TLS_KEY_FILE`        | *(none)*         | PEM private key (when `GATEWAY_TLS=true`) |
/// | `RUST_LOG`            | `info`           | Log filter — set `debug` for verbose per-connection traces, `trace` for TLS internals |
/// | `GATEWAY_HEALTH_ADDR`  | `0.0.0.0:8080`   | HTTP health-check listener — point NLB health checks here |

mod auth;
mod config;
mod handler;
mod health;
mod tls;
mod transform;

use std::sync::Arc;

use tokio::net::TcpListener;
use tracing::{debug, error, info, warn};
use tracing_subscriber::{EnvFilter, fmt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // ── Initialise structured logging ────────────────────────────────────────
    // `RUST_LOG` controls verbosity at runtime:
    //   RUST_LOG=info    — normal production output (default)
    //   RUST_LOG=debug   — per-connection detail: handshake bytes, proxy steps
    //   RUST_LOG=trace   — includes rustls / tokio internals
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(true)
        .init();

    info!("fleetshell-gateway starting up");

    // ── Load configuration ───────────────────────────────────────────────────
    let cfg = config::Config::from_env();
    info!(listen_addr = %cfg.listen_addr, "configuration loaded");

    // ── Build TLS acceptor (only when gateway-level TLS is enabled) ──────────
    //
    // Set GATEWAY_TLS=false when an upstream load balancer (AWS NLB / ALB)
    // terminates TLS and forwards plain TCP to this container.  In that case
    // the load balancer holds the ACM certificate for the gateway hostname and
    // the gateway itself speaks plain TCP on its backend port.
    let tls_acceptor: Option<tokio_rustls::TlsAcceptor> = if cfg.tls_enabled {
        let acceptor = tls::build_acceptor(&cfg)?;
        info!("gateway TLS enabled — handling TLS on the listening socket");
        Some(acceptor)
    } else {
        info!(
            "GATEWAY_TLS=false — plaintext mode;              TLS must be terminated by an upstream load balancer"
        );
        None
    };

    // ── Bind TCP listener ────────────────────────────────────────────────────
    let listener = TcpListener::bind(&cfg.listen_addr).await?;
    info!(
        addr = %cfg.listen_addr,
        tls  = cfg.tls_enabled,
        "listener bound — waiting for connections"
    );

    // Shared config — used in handler for JWT validation and proxy-mode TLS.
    let config = Arc::new(cfg);

    // Shared JWT secret derived from config — cloned cheaply per spawned task.
    let jwt_secret = Arc::new(config.jwt_secret.clone());

    // Default transform hook (no-op).  Swap in a custom implementation to
    // inspect or mutate HTTP payloads in proxy mode.
    let hook: Arc<dyn transform::TransformHook> = Arc::new(transform::NoopHook);

    // ── Health-check server (separate port, HTTP) ────────────────────────────
    //
    // Spawn before the main accept loop so the NLB target shows "healthy"
    // as quickly as possible after container start.  Point the NLB health
    // check at HTTP on this port to avoid flooding the tunnel handler with
    // TCP probe connections.
    tokio::spawn(health::serve(config.health_addr.clone()));

    // ── Accept loop ──────────────────────────────────────────────────────────
    loop {
        let (tcp_stream, peer_addr) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                error!("TCP accept error: {e}");
                // Brief back-off to avoid a tight spin on persistent errors.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };

        // Log at the TCP layer before any TLS or handler work so we can
        // distinguish "no connections arriving" from "connections arriving
        // but failing silently".
        info!(%peer_addr, "TCP connection accepted");

        let jwt_secret = Arc::clone(&jwt_secret);
        let config     = Arc::clone(&config);
        let hook       = Arc::clone(&hook);

        if let Some(ref acceptor) = tls_acceptor {
            // Gateway terminates TLS itself.
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                debug!(%peer_addr, "starting TLS handshake");
                match acceptor.accept(tcp_stream).await {
                    Ok(tls_stream) => {
                        debug!(%peer_addr, "TLS handshake complete");
                        handler::handle(tls_stream, peer_addr, jwt_secret, config, hook).await;
                    }
                    Err(e) => {
                        warn!(%peer_addr, "TLS handshake failed: {e}");
                    }
                }
            });
        } else {
            // TLS terminated upstream — pass the plain TCP stream directly.
            tokio::spawn(async move {
                handler::handle(tcp_stream, peer_addr, jwt_secret, config, hook).await;
            });
        }
    }
}
