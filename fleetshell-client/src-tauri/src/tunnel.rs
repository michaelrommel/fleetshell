/// Per-port TCP listeners, gateway tunnel sessions, and local app launching.
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use std::pin::Pin;
use std::task::{Context, Poll};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

use crate::server::{ApiState, PortRow, TunnelRequest};
use tauri::Manager as _;  // for AppHandle::state()

// ── Gateway connection (plain TCP or TLS) ──────────────────────────────────

/// Unified gateway stream — either raw TCP (debug) or TLS (production).
///
/// Allows all downstream code to stay generic without duplicating logic for
/// each transport mode.
pub(crate) enum GatewayConn {
    Plain(TcpStream),
    Tls(tokio_rustls::client::TlsStream<TcpStream>),
}

impl AsyncRead for GatewayConn {
    fn poll_read(
        self: Pin<&mut Self>,
        cx:   &mut Context<'_>,
        buf:  &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Self::Tls(s)   => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for GatewayConn {
    fn poll_write(
        self: Pin<&mut Self>,
        cx:   &mut Context<'_>,
        buf:  &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Self::Tls(s)   => Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(
        self: Pin<&mut Self>,
        cx:   &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_flush(cx),
            Self::Tls(s)   => Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(
        self: Pin<&mut Self>,
        cx:   &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Self::Tls(s)   => Pin::new(s).poll_shutdown(cx),
        }
    }
}

// Both TcpStream and TlsStream<TcpStream> are Unpin.
impl Unpin for GatewayConn {}

/// Connect to the gateway, returning either a plain TCP stream or a TLS stream
/// depending on the config flags.
///
/// - `disable_tls=true`  — plain TCP; use only for local debugging.
/// - `skip_verify=true`  — TLS but accept self-signed certs.
/// - both false          — TLS with OS trust store (production default).
pub(crate) async fn connect_gateway(
    gw_addr:     &str,
    gw_host:     &str,
    skip_verify: bool,
    disable_tls: bool,
) -> Result<GatewayConn, String> {
    let tcp = TcpStream::connect(gw_addr)
        .await
        .map_err(|e| format!("gateway TCP connect failed ({}): {}", gw_addr, e))?;

    if disable_tls {
        log::warn!(
            "Gateway TLS is DISABLED (gateway_disable_tls=true) — \
             connecting with plain TCP. Use only in local/dev environments."
        );
        return Ok(GatewayConn::Plain(tcp));
    }

    let connector = make_tls_connector(skip_verify)
        .map_err(|e| format!("TLS setup failed: {}", e))?;

    let server_name = rustls::pki_types::ServerName::try_from(gw_host)
        .map_err(|e| format!("invalid gateway hostname '{}': {}", gw_host, e))?
        .to_owned();

    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|e| format!("TLS handshake with gateway failed: {}", e))?;

    Ok(GatewayConn::Tls(tls))
}

// ── Per-port connection config ────────────────────────────────────────────────

/// Flat, per-port configuration extracted from a `TunnelRequest` + `PortRow`.
///
/// This is what every accept-loop / connection handler needs.  Creating it
/// early lets us drop the `TunnelRequest` borrow before spawning tasks.
#[derive(Debug, Clone)]
pub struct PortConfig {
	pub target:      String,
	pub token:       String,
	pub gateway:     String,
	pub servicekey:  Option<String>,
	/// Protocol the device speaks — "http", "https", "rdp", "vnc".
	pub application: String,
	/// When `true`, route through guacd for a browser-based Guacamole session.
	pub guac:        Option<bool>,
	/// `true` = raw TLS relay; `false`/absent = HTTP proxy mode (default).
	pub e2ecrypt:    Option<bool>,
	/// SNI hostname for proxy-mode HTTP/S upstream connections.
	pub sni:         Option<String>,
	/// RDP / VNC username (from the portal device database).
	pub username:    Option<String>,
	/// RDP / VNC password (from the portal device database). Never logged.
	pub password:    Option<String>,
	/// Requested display width in pixels for Guacamole sessions.
	pub width:       Option<u32>,
	/// Requested display height in pixels for Guacamole sessions.
	pub height:      Option<u32>,
	/// Dots per inch for Guacamole sessions.
	pub dpi:         Option<u32>,
}

impl PortConfig {
	pub fn from_request(req: &TunnelRequest, row: &PortRow) -> Self {
		Self {
			target:      req.target.clone(),
			token:       req.token.clone(),
			gateway:     req.gateway.clone(),
			servicekey:  req.servicekey.clone(),
			application: row.application.clone(),
			guac:        row.guac,
			e2ecrypt:    row.e2ecrypt,
			sni:         row.sni.clone(),
			username:    req.username.clone(),
			password:    req.password.clone(),
			width:       req.width,
			height:      req.height,
			dpi:         req.dpi,
		}
	}
}

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

/// Build a rustls TLS connector for outbound gateway connections.
///
/// **Normal mode** — trusts the system certificate store so that enterprise
/// root CAs installed via MDM / GPO (e.g. zScaler) are automatically
/// accepted without any code change.
///
/// **Skip-verify mode** — when `skip_verify` is `true` the connector accepts
/// *any* server certificate.  TLS encryption is still active; only the
/// authenticity of the server certificate is not checked.  Controlled by the
/// `gateway_skip_tls_verify` setting in the client config.
/// Use only against gateways with self-signed certificates (local / dev).
pub(crate) fn make_tls_connector(skip_verify: bool) -> Result<TlsConnector, Box<dyn std::error::Error + Send + Sync>> {
    if skip_verify {
        log::warn!(
            "Gateway TLS certificate validation is DISABLED (gateway_skip_tls_verify=true). \
             Self-signed certificates accepted. Do not use in production."
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
    listener:     tokio::net::TcpListener,
    local_port:   u16,
    target_port:  u16,
    cfg:          PortConfig,
    state:        ApiState,
    last_active:  Arc<AtomicU64>,
    task_handles: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
) {
    // `local_port` is the port this loopback listener is bound on; it may differ
    // from `target_port` when the requested port was already in use locally and
    // we fell back to an ephemeral one.  Only `target_port` reaches the gateway
    // (via the handshake payload); `local_port` is purely the browser/app
    // rendezvous address.
    log::info!("local port {} (target {}) - tunnel listener ready", local_port, target_port);

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                log::debug!("local port {} - accepted connection from {}", local_port, peer);
                let cfg_c   = cfg.clone();
                let state_c = state.clone();
                let last_c  = last_active.clone();

                let handle = tokio::spawn(
                    handle_connection(stream, target_port, cfg_c, state_c, last_c),
                );

                // Store the handle; prune finished entries first to prevent
                // unbounded growth over the lifetime of the slot.
                if let Ok(mut pool) = task_handles.lock() {
                    pool.retain(|h| !h.is_finished());
                    pool.push(handle);
                }
            }
            Err(e) => {
                log::error!("local port {} - accept error: {}", local_port, e);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

// ── Per-connection gateway handshake ─────────────────────────────────────────

async fn handle_connection(local: TcpStream, port: u16, cfg: PortConfig, state: ApiState, last_active: Arc<AtomicU64>) {
    let (gw_host, gw_port) = parse_gateway(&cfg.gateway);
    let gw_addr = format!("{}:{}", gw_host, gw_port);

    log::debug!("port {} — connecting to gateway {} (TLS)", port, gw_addr);

    let app_cfg = crate::config::load(&state.app);
    let mut gw = match connect_gateway(
        &gw_addr, &gw_host,
        app_cfg.gateway_skip_tls_verify,
        app_cfg.gateway_disable_tls,
    ).await {
        Ok(g)  => g,
        Err(e) => {
            log::error!("port {} — {}", port, e);
            crate::util::navigate(&state.app, "logging");
            return;
        }
    };
    let _ = &mut gw; // suppress unused-mut warning when TLS branch not taken

    let payload = build_payload(&cfg, port, &state.gateway_path);

    if !cfg.e2ecrypt.unwrap_or(false)
        && (cfg.application.eq_ignore_ascii_case("https")
            || cfg.application.eq_ignore_ascii_case("expert-i"))
    {
        // Clone the Arc<RwLock<...>> out of managed state so the tauri::State
        // borrow is released before the async .read().await.  TlsAcceptor is
        // Arc<ServerConfig> internally, so the subsequent clone is cheap.
        let tls_arc = state.app.state::<crate::server::TlsState>().0.clone();
        let acceptor_opt = tls_arc.read().await.clone();
        match acceptor_opt {
            Some(acceptor) => {
                log::info!(
                    "port {} — HTTPS proxy mode: terminating browser TLS at client",
                    port
                );
                match acceptor.accept(local).await {
                    Ok(local_tls) => {
                        do_tunnel(local_tls, gw, &payload, port, &state.app, last_active)
                            .await;
                    }
                    Err(e) => {
                        log::error!("port {} — browser TLS accept failed: {e}", port);
                        crate::util::navigate(&state.app, "logging");
                    }
                }
            }
            None => {
                // Client not yet enrolled — no cert available to terminate TLS.
                // Fall back to transparent relay so the user can at least reach
                // devices with valid certificates.
                log::warn!(
                    "port {} — HTTPS proxy mode: no TLS cert yet (enroll first);                      falling back to e2ecrypt passthrough",
                    port
                );
                do_tunnel(local, gw, &payload, port, &state.app, last_active).await;
            }
        }
    } else {
        do_tunnel(local, gw, &payload, port, &state.app, last_active).await;
    }
}

// ── Handshake + bidirectional forwarding ──────────────────────────────────────

/// Build the JSON payload sent to the gateway on first connect.
pub(crate) fn build_payload(cfg: &PortConfig, port: u16, gateway_path: &str) -> Vec<u8> {
    let json = serde_json::json!({
        "target":      cfg.target,
        "application": cfg.application,
        "port":        port,
        "token":       cfg.token,
        "servicekey":  cfg.servicekey,
        "gateway":     cfg.gateway,
        "sni":         cfg.sni,
        "path":        gateway_path,
        "e2ecrypt":    cfg.e2ecrypt,
        "guac":        cfg.guac,
        "username":    cfg.username,
        "password":    cfg.password,
        "width":       cfg.width,
        "height":      cfg.height,
        "dpi":         cfg.dpi,
    });
    let mut bytes = json.to_string().into_bytes();
    bytes.push(b'\n');
    bytes
}

/// Send the JSON payload, read the gateway's response line, then forward
/// bytes bidirectionally if the response is `"200 CONNECTED"`.
async fn do_tunnel<L, S>(
    mut local:   L,
    mut gateway: S,
    payload:     &[u8],
    port:        u16,
    app:         &tauri::AppHandle,
    last_active: Arc<AtomicU64>,
) where
    L: AsyncRead + AsyncWrite + Unpin + Send,
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

    // If the gateway replied with an HTTP response line, ZScaler (or another
    // transparent proxy) has intercepted the TLS connection and injected a
    // block page.  Drain the rest of the HTTP response, submit the bypass
    // form, and tell the user to retry — the next connection will go through.
    if upper.starts_with("HTTP/") {
        crate::zscaler::handle_gateway_block(&mut gateway, &response, port, app).await;
        return;
    }

    if !upper.starts_with("200") || !upper.contains("CONNECTED") {
        log::error!("port {} — gateway refused: '{}'", port, response);
        crate::util::navigate(app, "logging");
        return;
    }

    log::info!("port {} — tunnel established, forwarding data", port);

    match copy_tracked(&mut local, &mut gateway, &last_active).await {
        Ok(_)  => log::info!("port {} — tunnel closed", port),
        Err(e) => log::debug!("port {} — tunnel error: {}", port, e),
    }
}

// ── Traffic-tracked bidirectional copy ────────────────────────────────────────

/// Copy bytes between `a` and `b` in both directions, updating `last_active`
/// whenever any data flows.  Used instead of `tokio::io::copy_bidirectional`
/// so the idle monitor can detect real traffic vs. an open-but-silent connection.
async fn copy_tracked<A, B>(
    a:           &mut A,
    b:           &mut B,
    last_active: &AtomicU64,
) -> std::io::Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let mut buf_a = vec![0u8; 16_384];
    let mut buf_b = vec![0u8; 16_384];

    loop {
        tokio::select! {
            // A → B
            res = a.read(&mut buf_a) => {
                match res? {
                    0 => { let _ = b.shutdown().await; break; }
                    n => {
                        b.write_all(&buf_a[..n]).await?;
                        last_active.store(crate::slot::now_secs(), Ordering::Relaxed);
                    }
                }
            }
            // B → A
            res = b.read(&mut buf_b) => {
                match res? {
                    0 => { let _ = a.shutdown().await; break; }
                    n => {
                        a.write_all(&buf_b[..n]).await?;
                        last_active.store(crate::slot::now_secs(), Ordering::Relaxed);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Read bytes from `reader` until `\n` or EOF, up to `max_bytes`.
/// Returns the line without the trailing newline.
pub(crate) async fn read_line<R: AsyncRead + Unpin>(
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

// ── Gateway probe ─────────────────────────────────────────────────────────────────

/// Ask the gateway to perform a TCP reachability check against `target:port`.
///
/// Sends a `"probe"` application handshake over the same TLS channel used by
/// normal tunnel connections.  The gateway attempts a TCP connect with a
/// 3-second timeout and responds with a single status line:
///
/// - `"200 REACHABLE"`   — the target accepted the SYN
/// - `"503 UNREACHABLE"` — connection refused or timeout
///
/// Returns:
/// - `Ok(true)`  — target reachable
/// - `Ok(false)` — target unreachable
/// - `Err(…)`   — could not reach the gateway, or unexpected response
pub async fn probe_target(
    target:          &str,
    port:            u16,
    gateway:         &str,
    token:           &str,
    gateway_path:    &str,
    skip_tls_verify: bool,
    disable_tls:     bool,
) -> Result<bool, String> {
    let (gw_host, gw_port) = parse_gateway(gateway);
    let gw_addr = format!("{}:{}", gw_host, gw_port);

    let mut tls = connect_gateway(&gw_addr, &gw_host, skip_tls_verify, disable_tls).await?;

    let payload = serde_json::json!({
        "target":      target,
        "application": "probe",
        "port":        port,
        "token":       token,
        "gateway":     gateway,
        "path":        gateway_path,
    });
    let mut bytes = payload.to_string().into_bytes();
    bytes.push(b'\n');

    tls.write_all(&bytes)
        .await
        .map_err(|e| format!("Probe write failed: {e}"))?;
    tls.flush()
        .await
        .map_err(|e| format!("Probe flush failed: {e}"))?;

    let response = read_line(&mut tls, 64)
        .await
        .map_err(|e| format!("Probe read failed: {e}"))?;
    let upper = response.trim().to_uppercase();

    if upper.starts_with("200") {
        Ok(true)
    } else if upper.starts_with("503") {
        Ok(false)
    } else if upper.starts_with("401") || upper.starts_with("403") {
        Err(format!("Gateway rejected probe: {response}"))
    } else {
        Err(format!("Unexpected probe response: {response}"))
    }
}

// ── Local application launcher ────────────────────────────────────────────────

/// Return the browser URL for an http / https / expert-i tunnel.
/// Returns `None` for application types that use native apps (rdp/vnc/ssh).
///
/// `path` is an optional suffix appended after `host:port` (e.g. `"/adminportal"`).
/// An empty string or `"/"` is treated as the root and produces no suffix.
pub fn get_tunnel_url(application: &str, port: u16, bind_ip: &str, path: &str) -> Option<String> {
    let suffix = normalise_path(path);
    match application.to_lowercase().as_str() {
        "http"     => Some(format!("http://{}:{}{}",  dns_host(bind_ip), port, suffix)),
        "https"    => Some(format!("https://{}:{}{}", dns_host(bind_ip), port, suffix)),
        "expert-i" => Some(format!("https://{}:{}{}", dns_host(bind_ip), port, suffix)),
        _          => None,
    }
}

/// Normalise a path string for appending to a base URL.
///
/// - Empty or `"/"` → returns `""` (no suffix; callers get a clean `host:port`).
/// - Otherwise ensures a leading `'/'` and returns the path as-is.
fn normalise_path(path: &str) -> String {
    let p = path.trim();
    if p.is_empty() || p == "/" {
        return String::new();
    }
    if p.starts_with('/') {
        p.to_owned()
    } else {
        format!("/{p}")
    }
}

/// Launch the native application for an rdp / vnc / ssh tunnel.
///
/// Called from `POST /api/launch` so the user triggers the launch explicitly
/// rather than having it fire automatically on connect.
pub fn launch_native(
    application: &str,
    port:        u16,
    bind_ip:     &str,
    cfg:         &crate::config::AppConfig,
) {
    match application.to_lowercase().as_str() {
        "rdp" => launch_rdp(port, bind_ip),
        "vnc" => launch_vnc(port, bind_ip, cfg),
        "ssh" => log::info!("SSH port {} — native launcher not yet implemented", port),
        other => log::warn!("launch_native: unrecognised application '{}'", other),
    }
}

/// Map a slot bind-IP to its DNS hostname.
/// `"127.0.0.2"` → `"127-0-0-2.client.fleetshell.com"`
///
/// The wildcard cert (`*.client.fleetshell.com`) covers every name in this
/// range and each hostname resolves to the corresponding loopback address,
/// so the returned URL can be opened directly in a browser without warnings.
pub(crate) fn dns_host(bind_ip: &str) -> String {
    bind_ip.replace('.', "-") + ".client.fleetshell.com"
}

// ── RDP ───────────────────────────────────────────────────────────────────────

fn launch_rdp(port: u16, bind_ip: &str) {
    let path = match write_rdp_file(port, bind_ip) {
        Ok(p)  => p,
        Err(e) => {
            log::error!("RDP port {} — could not write temp file: {}", port, e);
            return;
        }
    };

    log::info!("RDP port {} — launching mstsc with {} on {}", port, path.display(), bind_ip);

    match std::process::Command::new("mstsc.exe")
        .arg(&path)
        .spawn()
    {
        Ok(_)  => log::info!("RDP port {} — mstsc.exe launched", port),
        Err(e) => log::error!("RDP port {} — failed to launch mstsc.exe: {}", port, e),
    }
}

fn write_rdp_file(port: u16, bind_ip: &str) -> std::io::Result<std::path::PathBuf> {
    // Include the IP in the filename so concurrent slots don't collide.
    let safe_ip = bind_ip.replace('.', "_");
    let path = std::env::temp_dir().join(format!("fleetshell_rdp_{}_{}.rdp", safe_ip, port));
    let content = format!(
        "full address:s:{bind_ip}:{port}\r\n\
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

fn launch_vnc(port: u16, bind_ip: &str, cfg: &crate::config::AppConfig) {
    let path = match write_vnc_file(port, bind_ip) {
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

fn write_vnc_file(port: u16, bind_ip: &str) -> std::io::Result<std::path::PathBuf> {
    let safe_ip = bind_ip.replace('.', "_");
    let path = std::env::temp_dir().join(format!("fleetshell_vnc_{}_{}.tigervnc", safe_ip, port));
    // ServerName uses double-colon notation for a direct TCP port number.
    // Single-colon would be a VNC display number (display N = port 5900+N).
    let content = format!(
        "TigerVNC Configuration file Version 1.0\r\n\
         \r\n\
         ServerName={bind_ip}::{port}\r\n\
         SecurityTypes=None,VncAuth,RA2ne,RA2ne_256,Plain,DH,MSLogonII,TLSNone,TLSVnc,TLSPlain,X509None,X509Vnc,X509Plain,RA2,RA2_256\r\n\
         AlwaysCursor=on\r\n\
         CursorType=System\r\n"
    );
    std::fs::write(&path, content)?;
    Ok(path)
}
