/// Minimal HTTP health-check server.
///
/// Binds a separate TCP port (default `0.0.0.0:8080`) and responds to every
/// HTTP request with `200 OK`.  Configure the NLB health check to use
/// **HTTP on port 8080** (or whatever `GATEWAY_HEALTH_ADDR` is set to)
/// instead of TCP on the tunnel port so that:
///
/// * Health probes are handled cleanly with a real HTTP response.
/// * The tunnel handler never sees probe connections, eliminating the
///   "connection closed before sending handshake" log noise.
/// * Probe traffic is logged at `DEBUG` only — invisible at the default
///   `INFO` level.
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{debug, info, warn};

/// Canned HTTP/1.1 response returned for every health probe.
const RESPONSE: &[u8] = b"\
HTTP/1.1 200 OK\r\n\
Content-Type: application/json\r\n\
Content-Length: 15\r\n\
Connection: close\r\n\
\r\n\
{\"status\":\"ok\"}";

/// Bind `addr` and serve health-check responses forever.
///
/// Intended to be spawned as a background task:
/// ```ignore
/// tokio::spawn(health::serve(cfg.health_addr.clone()));
/// ```
pub async fn serve(addr: String) {
	let listener = match TcpListener::bind(&addr).await {
		Ok(l) => {
			info!(%addr, "health check listener bound");
			l
		}
		Err(e) => {
			warn!(%addr, "failed to bind health check listener: {e}");
			return;
		}
	};

	loop {
		match listener.accept().await {
			Ok((mut stream, peer)) => {
				tokio::spawn(async move {
					// Drain the incoming request — we don't care about the
					// path or headers, any HTTP request gets 200 back.
					let mut buf = [0u8; 512];
					let _ = stream.read(&mut buf).await;

					if stream.write_all(RESPONSE).await.is_ok() {
						let _ = stream.flush().await;
					}

					// DEBUG only — invisible at the default INFO level.
					debug!(%peer, "health check probe served");
				});
			}
			Err(e) => {
				warn!("health check accept error: {e}");
				tokio::time::sleep(std::time::Duration::from_millis(50)).await;
			}
		}
	}
}
