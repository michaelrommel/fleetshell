/// Gateway configuration loaded from environment variables.
///
/// All fields have sensible defaults for local development. Set the
/// `JWT_SECRET` variable to something strong in every real deployment.

use std::sync::Arc;
#[derive(Debug, Clone)]
pub struct Config {
    /// TCP address to listen on. Default: `0.0.0.0:8443`.
    pub listen_addr: String,

    /// HMAC-SHA256 secret used to verify incoming JWT tokens.
    /// Default: a hardcoded dev string — **always override in production**.
    pub jwt_secret: String,

    /// Optional path to a PEM-encoded certificate chain file.
    /// When both `tls_cert_file` and `tls_key_file` are set the gateway loads
    /// those instead of generating a self-signed certificate.
    pub tls_cert_file: Option<String>,

    /// Optional path to a PEM-encoded private-key file (PKCS#8 or SEC1).
    pub tls_key_file: Option<String>,

    /// Skip TLS certificate chain verification when the gateway opens its own
    /// TLS connection to an upstream server (transform mode, `application =
    /// "https"`).
    ///
    /// Default: `true` — appropriate for medical devices and other embedded
    /// targets that carry self-signed certificates.  Set to `false` in
    /// environments where the upstream presents a CA-signed certificate.
    pub upstream_tls_accept_invalid_certs: bool,

    /// Live guacd TCP streams parked after a client WebSocket disconnect.
    ///
    /// Keyed by the guacd `connection_id` (`$uuid` from the `ready`
    /// instruction).  A reconnecting client sends the same id back; the
    /// gateway unparks the stream and resumes the session.  Entries are
    /// removed on reconnect or when the grace-period timer fires.
    ///
    /// Shared across all handler tasks via `Arc<Mutex<_>>`.
    pub parked_sessions: Arc<tokio::sync::Mutex<
        std::collections::HashMap<String, tokio::net::TcpStream>
    >>,

    /// How long (seconds) to keep a guacd session parked after the browser
    /// WebSocket closes, waiting for a reconnect.
    ///
    /// Set via `GUAC_RECONNECT_GRACE_SECS`.  Default: 30.
    pub reconnect_grace_secs: u64,

    /// Whether the gateway handles TLS on its own listening socket.
    /// TLS (ACM certificate for `gateway.fleetshell.com`) and forwards plain
    /// TCP to the container fleet.  No certificate management is needed on the
    /// containers, and all containers in a scale-out group are identical.
    ///
    /// Set `GATEWAY_TLS=true` only for standalone / development deployments
    /// where no load balancer is in front of the gateway.  In that mode the
    /// gateway generates a self-signed certificate unless `TLS_CERT_FILE` and
    /// `TLS_KEY_FILE` are also provided.
    pub tls_enabled: bool,

    /// Address for the HTTP health-check listener.
    ///
    /// Responds to any HTTP request with `200 OK {"status":"ok"}`.  Configure
    /// the NLB health check to use HTTP on this port instead of TCP on the
    /// traffic port so health probes never appear in the tunnel handler logs.
    ///
    /// Default: `0.0.0.0:8080`.
    pub health_addr: String,

    /// Address of the guacd daemon running in the same container.
    ///
    /// guacd is started by `run.sh` and bound to the loopback interface only;
    /// this address is never reachable from outside the container.
    ///
    /// Set via the `GUACD_ADDR` environment variable (exported by `run.sh`).
    /// Default: `127.0.0.1:4822`.
    pub guacd_addr: String,

    /// Root directory on the gateway host used for RDP drive sharing.
    ///
    /// When set (via `GUACD_DRIVE_PATH`), RDP sessions that request drive
    /// sharing (`enable_drive: true` in the handshake) will have guacd mount
    /// this path as a virtual drive inside the Windows session.  guacd is
    /// instructed to create per-session sub-directories automatically
    /// (`drive-create-path = true`), so only the root needs to exist.
    ///
    /// The directory must be writable by the guacd process (UID 1000 / user
    /// `guacd`).  The Dockerfile creates `/guac-drives` with the correct
    /// ownership for this purpose.
    ///
    /// When absent (not set or empty) drive sharing is silently disabled
    /// even if the client requests it.
    pub guacd_drive_path: Option<String>,
}

impl Config {
    /// Build a `Config` from environment variables.
    pub fn from_env() -> Self {
        let jwt_secret = match std::env::var("JWT_SECRET") {
            Ok(s) if !s.is_empty() => s,
            _ => {
                eprintln!(
                    "WARNING: JWT_SECRET is not set — using insecure development default. \
                     Set this variable before deploying to production."
                );
                "change-me-in-production".to_string()
            }
        };

        Self {
            listen_addr: std::env::var("GATEWAY_LISTEN_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8443".to_string()),
            jwt_secret,
            tls_cert_file: std::env::var("TLS_CERT_FILE").ok(),
            tls_key_file:  std::env::var("TLS_KEY_FILE").ok(),
            upstream_tls_accept_invalid_certs: std::env::var(
                "GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS",
            )
            .map(|v| !(v.eq_ignore_ascii_case("false") || v == "0"))
            .unwrap_or(true),

            tls_enabled: std::env::var("GATEWAY_TLS")
                .map(|v| !(v.eq_ignore_ascii_case("false") || v == "0"))
                .unwrap_or(false),

            health_addr: std::env::var("GATEWAY_HEALTH_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8080".to_string()),

            guacd_addr: std::env::var("GUACD_ADDR")
                .unwrap_or_else(|_| "127.0.0.1:4822".to_string()),

            guacd_drive_path: std::env::var("GUACD_DRIVE_PATH")
                .ok()
                .filter(|s| !s.is_empty()),

            parked_sessions: Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new()
            )),

            reconnect_grace_secs: std::env::var("GUAC_RECONNECT_GRACE_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30),
        }
    }
}
