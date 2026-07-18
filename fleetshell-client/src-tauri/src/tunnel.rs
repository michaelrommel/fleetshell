/// Per-port TCP listeners, gateway tunnel sessions, and local app launching.
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

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

// ── Gateway address parser ────────────────────────────────────────────────────

/// Split a gateway string into `(sni_hostname, tcp_port)`.
///
/// Accepted formats:
/// - `"atlanta-01"`         → `("atlanta-01",  443)`
/// - `"atlanta-01:8443"`    → `("atlanta-01",  8443)`
/// - `"192.0.2.1:9443"`     → `("192.0.2.1",   9443)`
/// - `"[::1]:8443"`         → `("::1",          8443)`  (SNI host without brackets)
/// - `"[::1]"`              → `("::1",          443)`
pub fn parse_gateway(gateway: &str) -> (String, u16) {
    // Bracketed IPv6: "[::1]:8443" or "[::1]"
    if let Some(rest) = gateway.strip_prefix('[') {
        if let Some(bracket_end) = rest.find(']') {
            let host = rest[..bracket_end].to_string();   // strip brackets for SNI
            let port = rest[bracket_end + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse().ok())
                .unwrap_or(443);
            return (host, port);
        }
    }

    // "host:port" or plain "host"
    if let Some(colon) = gateway.rfind(':') {
        let port_str = &gateway[colon + 1..];
        if let Ok(port) = port_str.parse::<u16>() {
            return (gateway[..colon].to_string(), port);
        }
    }
    (gateway.to_string(), 443)
}

// ── TLS helper ────────────────────────────────────────────────────────────────

/// Build a rustls TLS connector.
///
/// **Normal mode** — trusts the system certificate store so that enterprise
/// root CAs installed via MDM / GPO (e.g. zScaler) are automatically
/// accepted without any code change.
///
/// **Skip-verify mode** — when the environment variable
/// `GATEWAY_SKIP_TLS_VERIFY=1` is set the connector accepts *any* server
/// certificate.  TLS encryption is still active; only the authenticity of
/// the server certificate is not checked.  Use this only during local
/// development against a gateway that presents a self-signed certificate.
/// **Never set this variable in production.**
fn make_tls_connector() -> Result<TlsConnector, Box<dyn std::error::Error + Send + Sync>> {
    let skip_verify = std::env::var("GATEWAY_SKIP_TLS_VERIFY")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false);

    if skip_verify {
        log::warn!(
            "GATEWAY_SKIP_TLS_VERIFY is set — TLS certificate validation is DISABLED. \
             Do not use this in production."
        );
        let config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipServerVerification))
            .with_no_client_auth();
        return Ok(TlsConnector::from(Arc::new(config)));
    }

    let native = rustls_native_certs::load_native_certs();

    // Warn about individual certs that could not be read; still proceed with
    // whatever the OS gave us — a partial store is better than none.
    for err in &native.errors {
        log::warn!("native CA cert load warning: {}", err);
    }

    let mut root_store = rustls::RootCertStore::empty();
    let (added, rejected) = root_store.add_parsable_certificates(native.certs);
    log::debug!("native CA store: {} added, {} rejected", added, rejected);

    if added == 0 {
        return Err("no CA certificates could be loaded from the system trust store".into());
    }

    let config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

// ── Development-only: skip TLS certificate verification ───────────────────────

/// A [`ServerCertVerifier`] that accepts any server certificate.
///
/// The TLS channel is still encrypted — only the certificate chain and
/// hostname are not validated.  This makes connections vulnerable to
/// man-in-the-middle attacks and must never be used in production.
#[derive(Debug)]
struct SkipServerVerification;

impl ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// ── Per-port accept loop ──────────────────────────────────────────────────────

/// Accept connections on an already-bound `TcpListener`, spawning a
/// `handle_connection` task for every incoming local TCP connection.
pub async fn run_accept_loop(
    listener: tokio::net::TcpListener,
    port:     u16,
    req:      TunnelRequest,
    state:    ApiState,
) {
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
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

// ── Per-connection gateway handshake ─────────────────────────────────────────

async fn handle_connection(local: TcpStream, port: u16, req: TunnelRequest, state: ApiState) {
    // The gateway connection is always TLS regardless of the `application`
    // field.  The `application` field describes what is being tunnelled, not
    // how the client↔gateway leg is secured.
    let (gw_host, gw_port) = parse_gateway(&req.gateway);
    let gw_addr = format!("{}:{}", gw_host, gw_port);

    log::debug!("port {} — connecting to gateway {} (TLS)", port, gw_addr);

    let tcp = match TcpStream::connect(&gw_addr).await {
        Ok(s)  => s,
        Err(e) => {
            log::error!("port {} — gateway connect failed ({}): {}", port, gw_addr, e);
            crate::util::navigate(&state.app, "logging");
            return;
        }
    };

    let connector = match make_tls_connector() {
        Ok(c)  => c,
        Err(e) => {
            log::error!("port {} — TLS setup failed: {}", port, e);
            crate::util::navigate(&state.app, "logging");
            return;
        }
    };

    let server_name = match rustls::pki_types::ServerName::try_from(gw_host.as_str()) {
        Ok(n)  => n.to_owned(),
        Err(e) => {
            log::error!("port {} — invalid gateway hostname '{}': {}", port, gw_host, e);
            crate::util::navigate(&state.app, "logging");
            return;
        }
    };

    let tls = match connector.connect(server_name, tcp).await {
        Ok(s)  => s,
        Err(e) => {
            log::error!("port {} — TLS handshake failed: {}", port, e);
            crate::util::navigate(&state.app, "logging");
            return;
        }
    };

    let payload = build_payload(&req, port, &state.gateway_path);
    do_tunnel(local, tls, &payload, port, &state.app).await;
}

// ── Handshake + bidirectional forwarding ──────────────────────────────────────

/// Build the JSON payload sent to the gateway on first connect.
fn build_payload(req: &TunnelRequest, port: u16, gateway_path: &str) -> Vec<u8> {
    let json = serde_json::json!({
        "target":      req.target,
        "application": req.application,
        "port":        port,
        "token":       req.token,
        "servicekey":  req.servicekey,
        "gateway":     req.gateway,
        "path":        gateway_path,
    });
    let mut bytes = json.to_string().into_bytes();
    bytes.push(b'\n');
    bytes
}

/// Send the JSON payload, read the gateway's response line, then forward
/// bytes bidirectionally if the response is `"200 CONNECTED"`.
async fn do_tunnel<S>(
    mut local:   TcpStream,
    mut gateway: S,
    payload:     &[u8],
    port:        u16,
    app:         &tauri::AppHandle,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    if let Err(e) = gateway.write_all(payload).await {
        log::error!("port {} — payload write failed: {}", port, e);
        crate::util::navigate(app, "logging");
        return;
    }
    if let Err(e) = gateway.flush().await {
        log::error!("port {} — flush failed: {}", port, e);
        crate::util::navigate(app, "logging");
        return;
    }

    let response = match read_line(&mut gateway, 1024).await {
        Ok(r)  => r,
        Err(e) => {
            log::error!("port {} — failed to read gateway response: {}", port, e);
            crate::util::navigate(app, "logging");
            return;
        }
    };
    let response = response.trim().to_string();
    log::info!("port {} — gateway: '{}'", port, response);

    let upper = response.to_uppercase();
    if !upper.starts_with("200") || !upper.contains("CONNECTED") {
        log::error!("port {} — gateway refused: '{}'", port, response);
        crate::util::navigate(app, "logging");
        return;
    }

    log::info!("port {} — tunnel established, forwarding data", port);

    match tokio::io::copy_bidirectional(&mut local, &mut gateway).await {
        Ok((to_gw, from_gw)) => log::info!(
            "port {} — tunnel closed (→gw {} B, ←gw {} B)",
            port, to_gw, from_gw
        ),
        Err(e) => log::debug!("port {} — tunnel error: {}", port, e),
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
            0 => break,
            _ => {
                if byte[0] == b'\n' { break; }
                buf.push(byte[0]);
                if buf.len() >= max_bytes { break; }
            }
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ── Local application launcher ────────────────────────────────────────────────

/// Prepare the local end of a tunnel for the given `application` type.
///
/// - `"http"` / `"https"` — returns a URL the caller can open in a browser.
/// - `"rdp"`  — writes a temp `.rdp` file and launches `mstsc.exe`.
/// - `"vnc"`  — writes a temp `.tigervnc` file and launches the first available
///              VNC viewer (`tvnviewer`, `vncviewer`, `vncviewer64`).
///
/// Returns a (possibly empty) list of URLs that the API caller may act on.
pub fn launch_application(
    application: &str,
    port:        u16,
    cfg:         &crate::config::AppConfig,
) -> Vec<String> {
    match application.to_lowercase().as_str() {
        "http"  => vec![format!("http://127.0.0.1:{}", port)],
        "https" => vec![format!("https://127.0.0.1:{}", port)],
        "rdp"   => { launch_rdp(port);       vec![] }
        "vnc"   => { launch_vnc(port, cfg);  vec![] }
        other   => {
            log::warn!("Unknown application type '{}' — no local app launched", other);
            vec![]
        }
    }
}

// ── RDP ───────────────────────────────────────────────────────────────────────

fn launch_rdp(port: u16) {
    let path = match write_rdp_file(port) {
        Ok(p)  => p,
        Err(e) => {
            log::error!("RDP port {} — could not write temp file: {}", port, e);
            return;
        }
    };

    log::info!("RDP port {} — launching mstsc with {}", port, path.display());

    match std::process::Command::new("mstsc.exe")
        .arg(&path)
        .spawn()
    {
        Ok(_)  => log::info!("RDP port {} — mstsc.exe launched", port),
        Err(e) => log::error!("RDP port {} — failed to launch mstsc.exe: {}", port, e),
    }
}

fn write_rdp_file(port: u16) -> std::io::Result<std::path::PathBuf> {
    let path = std::env::temp_dir().join(format!("fleetshell_rdp_{}.rdp", port));
    let content = format!(
        "full address:s:127.0.0.1:{port}\r\n\
         prompt for credentials:i:1\r\n\
         administrative session:i:0\r\n\
         redirectclipboard:i:1\r\n\
         redirectdrives:i:0\r\n\
         redirectprinters:i:0\r\n"
    );
    std::fs::write(&path, content)?;
    Ok(path)
}

// ── VNC ───────────────────────────────────────────────────────────────────────

fn launch_vnc(port: u16, cfg: &crate::config::AppConfig) {
    let path = match write_vnc_file(port) {
        Ok(p)  => p,
        Err(e) => {
            log::error!("VNC port {} — could not write temp file: {}", port, e);
            return;
        }
    };

    // Use the configured path when set; otherwise try well-known names from PATH.
    let candidates: Vec<&str> = if cfg.vnc_viewer.is_empty() {
        vec!["tvnviewer.exe", "vncviewer64.exe", "vncviewer.exe"]
    } else {
        vec![cfg.vnc_viewer.as_str()]
    };

    for exe in &candidates {
        match std::process::Command::new(exe).arg(&path).spawn() {
            Ok(_) => {
                log::info!("VNC port {} — {} launched with {}", port, exe, path.display());
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                log::error!("VNC port {} — {} failed: {}", port, exe, e);
                return;
            }
        }
    }

    log::error!(
        "VNC port {} — no VNC viewer found (tried: {})",
        port,
        candidates.join(", ")
    );
}

fn write_vnc_file(port: u16) -> std::io::Result<std::path::PathBuf> {
    let path = std::env::temp_dir().join(format!("fleetshell_vnc_{}.tigervnc", port));
    // ServerName uses double-colon notation for a direct TCP port number.
    // Single-colon would be a VNC display number (display N = port 5900+N).
    let content = format!(
        "TigerVNC Configuration file Version 1.0\r\n\
         \r\n\
         ServerName=127.0.0.1::{port}\r\n\
         SecurityTypes=None,VncAuth,RA2ne,RA2ne_256,Plain,DH,MSLogonII,TLSNone,TLSVnc,TLSPlain,X509None,X509Vnc,X509Plain,RA2,RA2_256\r\n\
         AlwaysCursor=on\r\n\
         CursorType=System\r\n"
    );
    std::fs::write(&path, content)?;
    Ok(path)
}
