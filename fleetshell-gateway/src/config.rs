/// Gateway configuration loaded from environment variables.
///
/// All fields have sensible defaults for local development. Set the
/// `JWT_SECRET` variable to something strong in every real deployment.

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
        }
    }
}
