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
/// | `TLS_CERT_FILE`       | *(none)*         | PEM cert chain (production TLS) |
/// | `TLS_KEY_FILE`        | *(none)*         | PEM private key (production TLS)|
/// | `RUST_LOG`            | `info`           | Log filter (tracing syntax)     |

mod auth;
mod config;
mod handler;
mod tls;
mod transform;

use std::sync::Arc;

use tokio::net::TcpListener;
use tracing::{error, info, warn};
use tracing_subscriber::{EnvFilter, fmt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // ── Initialise structured logging ────────────────────────────────────────
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("fleetshell_gateway=info,warn")),
        )
        .with_target(false)
        .init();

    info!("fleetshell-gateway starting up");

    // ── Load configuration ───────────────────────────────────────────────────
    let cfg = config::Config::from_env();
    info!(listen_addr = %cfg.listen_addr, "configuration loaded");

    // ── Build TLS acceptor ───────────────────────────────────────────────────
    let acceptor = tls::build_acceptor(&cfg)?;

    // ── Bind TCP listener ────────────────────────────────────────────────────
    let listener = TcpListener::bind(&cfg.listen_addr).await?;
    info!(addr = %cfg.listen_addr, "TLS listener bound — waiting for connections");

    // Shared config — used in handler for JWT validation and transform-mode
    // TLS settings.
    let config = Arc::new(cfg);

    // Shared JWT secret derived from config — cloned cheaply per spawned task.
    let jwt_secret = Arc::new(config.jwt_secret.clone());

    // Default transform hook (no-op).  Swap in a custom implementation to
    // inspect or mutate HTTP payloads in transform mode.
    let hook: Arc<dyn transform::TransformHook> = Arc::new(transform::NoopHook);

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

        let acceptor   = acceptor.clone();
        let jwt_secret = Arc::clone(&jwt_secret);
        let config     = Arc::clone(&config);
        let hook       = Arc::clone(&hook);

        tokio::spawn(async move {
            // Complete the TLS handshake before calling into the handler.
            match acceptor.accept(tcp_stream).await {
                Ok(tls_stream) => {
                    handler::handle(tls_stream, peer_addr, jwt_secret, config, hook).await;
                }
                Err(e) => {
                    warn!(%peer_addr, "TLS handshake failed: {e}");
                }
            }
        });
    }
}
