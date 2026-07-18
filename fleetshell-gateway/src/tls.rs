/// TLS acceptor construction.
///
/// Two modes are supported:
///
/// * **Self-signed** — generated at startup via `rcgen` when no cert/key
///   files are configured (development default).
/// * **File-based** — PEM files pointed to by `TLS_CERT_FILE` and
///   `TLS_KEY_FILE` environment variables (production).
use std::sync::Arc;

use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::TlsAcceptor;
use tracing::{info, warn};

use crate::config::Config;

/// Build a [`TlsAcceptor`] from the gateway configuration.
pub fn build_acceptor(cfg: &Config) -> Result<TlsAcceptor, Box<dyn std::error::Error>> {
    let (certs, key) = match (&cfg.tls_cert_file, &cfg.tls_key_file) {
        (Some(cert_path), Some(key_path)) => {
            info!("loading TLS certificate from {cert_path}");
            load_pem_files(cert_path, key_path)?
        }
        (Some(_), None) | (None, Some(_)) => {
            return Err(
                "both TLS_CERT_FILE and TLS_KEY_FILE must be set together (or neither)".into()
            );
        }
        (None, None) => {
            warn!(
                "TLS_CERT_FILE / TLS_KEY_FILE not set — \
                 generating a self-signed certificate (NOT for production)"
            );
            generate_self_signed()?
        }
    };

    let server_cfg = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    Ok(TlsAcceptor::from(Arc::new(server_cfg)))
}

// ── Self-signed cert ──────────────────────────────────────────────────────────

fn generate_self_signed(
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), Box<dyn std::error::Error>> {
    let subject_alt_names = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
    ];

    let certified_key = rcgen::generate_simple_self_signed(subject_alt_names)?;

    // rcgen 0.14 returns DER-encoded data directly from the CertifiedKey
    let cert_der = CertificateDer::from(certified_key.cert.der().to_vec());
    let key_der  = PrivateKeyDer::Pkcs8(
        PrivatePkcs8KeyDer::from(certified_key.signing_key.serialize_der()),
    );

    info!(
        "self-signed certificate generated — \
         common name: localhost (valid for localhost and 127.0.0.1)"
    );

    Ok((vec![cert_der], key_der))
}

// ── PEM file loading ──────────────────────────────────────────────────────────

fn load_pem_files(
    cert_path: &str,
    key_path:  &str,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), Box<dyn std::error::Error>> {
    use std::io::BufReader;

    // ── Certificate chain ────────────────────────────────────────────────
    let cert_file = std::fs::File::open(cert_path)?;
    let mut cert_reader = BufReader::new(cert_file);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()?;

    if certs.is_empty() {
        return Err(format!("no certificates found in {cert_path}").into());
    }

    // ── Private key ──────────────────────────────────────────────────────
    let key_file = std::fs::File::open(key_path)?;
    let mut key_reader = BufReader::new(key_file);
    let key = rustls_pemfile::private_key(&mut key_reader)?
        .ok_or_else(|| format!("no private key found in {key_path}"))?;

    info!(
        "loaded {} certificate(s) from {cert_path}",
        certs.len()
    );

    Ok((certs, key))
}
