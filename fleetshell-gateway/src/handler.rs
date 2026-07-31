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
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tracing::{debug, error, info, warn};

use crate::auth;
use crate::config::Config;
use crate::guac;
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
    /// When `true` the gateway relays raw bytes end-to-end (transparent
    /// passthrough).  The browser's TLS session reaches the target device
    /// directly; the device's certificate is presented to the browser.
    /// Use only when the device has a browser-trusted certificate.
    ///
    /// When `false` or absent (the default), the gateway runs in HTTP/1.1
    /// proxy mode: parses each HTTP request / response and forwards them to
    /// the upstream over its own TLS session (self-signed certs accepted).
    pub e2ecrypt:    Option<bool>,

    /// Optional SNI / virtual-host name for HTTP(S) transform mode.
    ///
    /// When present and `application` is `"http"` or `"https"`:
    /// - Used as the TLS SNI hostname when opening the upstream TLS session
    ///   (instead of `target`, which is typically a bare IP address that is
    ///   not a valid SNI name and breaks name-based virtual hosting).
    /// - Injected as the `Host:` header value on every forwarded HTTP request
    ///   so the upstream server routes the request correctly.
    ///
    /// Has no effect in e2ecrypt passthrough mode — the gateway never sees
    /// HTTP headers when relaying raw bytes.
    pub sni:         Option<String>,

    /// When `true`, route through the local guacd daemon instead of opening
    /// a raw TCP connection to the target.  guacd speaks Guacamole protocol
    /// to the client while translating to native RDP or VNC on the device.
    /// `application` must be `"rdp"`, `"vnc"`, or `"ssh"`.
    pub guac:        Option<bool>,

    /// RDP / VNC username supplied by the portal from its device database.
    /// Only meaningful when `guac` is `true`.
    pub username:    Option<String>,

    /// RDP / VNC password supplied by the portal from its device database.
    /// Only meaningful when `guac` is `true`.
    /// Never written to logs.
    pub password:    Option<String>,

    /// Requested display width in pixels for Guacamole sessions.
    /// Defaults to 1280 when absent.
    pub width:       Option<u32>,

    /// Requested display height in pixels for Guacamole sessions.
    /// Defaults to 800 when absent.
    pub height:      Option<u32>,

    /// Dots per inch for Guacamole sessions.  Defaults to 96 when absent.
    pub dpi:         Option<u32>,

    /// Request drive sharing for this RDP session.
    ///
    /// When `true` and `GUACD_DRIVE_PATH` is configured on the gateway,
    /// guacd will mount that directory as a virtual drive inside the Windows
    /// session.  Silently ignored for VNC/SSH, and when `GUACD_DRIVE_PATH`
    /// is not set on the gateway.
    pub enable_drive: Option<bool>,

    /// Request session recording for this RDP session.
    ///
    /// Authoritative value comes from the JWT `record` claim (server-signed);
    /// this field is accepted for completeness but the gateway cross-checks
    /// against the claim.  Silently ignored for VNC/SSH and when
    /// `GUACD_RECORDING_PATH` is not configured.
    pub enable_record: Option<bool>,

    /// Opaque identifier of a parked guacd session to resume.
    ///
    /// When the browser reloads, the client re-sends the `connection_id`
    /// returned in the previous `200 CONNECTED` response.  The gateway
    /// matches this to a parked guacd stream and bridges the new client
    /// directly — skipping the guacd opening handshake and preserving the
    /// running RDP/VNC session.
    ///
    /// `None` on the first connect (new session); `Some` on reconnect.
    pub connection_id:  Option<String>,
}

// ── Handler ───────────────────────────────────────────────────────────────────

/// Entry point called from the accept loop in `main`.
///
/// Generic over the I/O stream type so the same handler works both when the
/// gateway terminates TLS itself (`TlsStream<TcpStream>`) and when TLS is
/// terminated upstream and the gateway receives a plain `TcpStream`.
pub async fn handle<S>(
    stream:     S,
    peer:       SocketAddr,
    jwt_secret: Arc<String>,
    config:     Arc<Config>,
    hook:       Arc<dyn transform::TransformHook>,
)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    info!(%peer, "connection accepted");

    let (reader_half, mut writer_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader_half);

    // ── 1. Read handshake line ───────────────────────────────────────────
    let mut raw_line = String::new();
    match reader.read_line(&mut raw_line).await {
        Ok(0) => {
            // The NLB TCP health check opens a connection and closes it
            // immediately without sending any data.  This is normal and
            // expected — log at DEBUG so it does not pollute INFO output.
            // Switch the NLB health check to HTTP on the health port
            // (GATEWAY_HEALTH_ADDR) to eliminate these entirely.
            debug!(%peer, "connection closed before sending handshake (likely TCP health probe)");
            return;
        }
        Ok(n) => {
            info!(%peer, bytes = n, "handshake line received");
            // Log the raw bytes at DEBUG so we can spot NLB garbling or
            // unexpected TLS framing being forwarded as plaintext.
            debug!(%peer, raw = %raw_line.trim(), "raw handshake content");
        }
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
        target      = %payload.target,
        application = %payload.application,
        port        = payload.port,
        gateway     = %payload.gateway,
        path        = %payload.path,
        sni         = ?payload.sni,
        servicekey  = ?payload.servicekey,
        guac        = ?payload.guac,
        username    = ?payload.username,
        width       = ?payload.width,
        height      = ?payload.height,
        dpi         = ?payload.dpi,
        enable_drive  = ?payload.enable_drive,
        enable_record = ?payload.enable_record,
        "handshake payload"
    );
    // Token and password are intentionally not logged to avoid leaking credentials.
    info!(%peer, token_len = payload.token.len(), "JWT token received (not logged)");
    info!(%peer,
        password_len = payload.password.as_deref().map(|p| p.len()).unwrap_or(0),
        password_set = payload.password.as_deref().map(|p| !p.is_empty()).unwrap_or(false),
        "credential lengths (values not logged)");

    // ── 4. Validate JWT + authorise target / port ────────────────────────
    let jwt_record = match auth::verify_connection(
        &payload.token,
        &jwt_secret,
        &payload.target,
        payload.port,
        &payload.gateway,
    ) {
        Ok(claims) => {
            info!(
                %peer,
                sub = ?claims.sub,
                exp = ?claims.exp,
                iat = ?claims.iat,
                target = %claims.target,
                ports  = %claims.ports,
                gw     = ?claims.gw,
                record = ?claims.record,
                "JWT verified and connection authorised"
            );
            claims.record.unwrap_or(false)
        }
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
    };

    // ── 4b. Direct SSH mode (application="ssh", guac:false, e2ecrypt:false) ──────────
    //
    // When the client requests application:"ssh" without guac or e2ecrypt,
    // we speak SSH directly using russh — no guacd involved.  Raw PTY bytes
    // are delivered to the browser xterm.js renderer.
    //
    // When e2ecrypt:true, fall through to the raw TCP passthrough below so
    // a local SSH client can connect through the tunnel unmolested.
    // The existing guac:true + application:"ssh" path continues to work.
    if payload.application.eq_ignore_ascii_case("ssh")
        && !payload.guac.unwrap_or(false)
        && !payload.e2ecrypt.unwrap_or(false)
    {
        let params = crate::ssh::SshParams {
            hostname: payload.target.clone(),
            port:     payload.port,
            username: payload.username.clone().unwrap_or_default(),
            password: payload.password.clone().unwrap_or_default(),
            cols:     payload.width.map(|w| w / 8).unwrap_or(220).max(40),
            rows:     payload.height.map(|h| h / 16).unwrap_or(50).max(10),
        };

        info!(
            %peer,
            target   = %payload.target,
            port     = payload.port,
            username = %params.username,
            cols     = params.cols,
            rows     = params.rows,
            "direct SSH mode — bypassing guacd"
        );

        send_line(&mut writer_half, b"200 CONNECTED\n").await;

        // Reassemble the split stream so ssh::run receives a single I/O object.
        let stream = tokio::io::join(reader, writer_half);
        crate::ssh::run(stream, peer, params).await;
        return;
    }

    // ── 4c. Probe mode: check reachability without forwarding data ───────────
    //
    // The client sends `application: "probe"` to ask whether a target device
    // is currently accepting connections, before opening a real tunnel.
    // We attempt a TCP connect with a 3-second timeout, report the result,
    // and close — no data is forwarded.
    if payload.application.eq_ignore_ascii_case("probe") {
        let target_addr = format!("{}:{}", payload.target, payload.port);
        let reachable = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            TcpStream::connect(&target_addr),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false); // timeout counts as unreachable

        if reachable {
            info!(%peer, %target_addr, "probe: target reachable");
            send_line(&mut writer_half, b"200 REACHABLE\n").await;
        } else {
            info!(%peer, %target_addr, "probe: target unreachable or timed out");
            send_line(&mut writer_half, b"503 UNREACHABLE\n").await;
        }
        writer_half.shutdown().await.ok();
        return;
    }

    // ── 4c. Guacamole mode: connect via guacd instead of raw TCP ─────────────
    //
    // The response line carries the guacd connection_id so the client can
    // reconnect to the same session after a WebSocket drop:
    //
    //   200 CONNECTED $cf9dace0-fffd-4bef-97cc-ff3db89c18c8\n
    //
    // On reconnect the client sends the same id back in `connection_id`.
    // The gateway unparks the live guacd TcpStream and bridges the new
    // client to it, skipping the opening handshake entirely.
    if payload.guac.unwrap_or(false) {

        // ── Reconnect path ───────────────────────────────────────────────────────────
        if let Some(ref cid) = payload.connection_id {
            let parked = config.parked_sessions.lock().await.remove(cid);
            if let Some(mut guacd) = parked {
                info!(%peer, connection_id = %cid, "guacd reconnect — resuming parked session");
                let resp = format!("200 CONNECTED {}\n", cid);
                send_line(&mut writer_half, resp.as_bytes()).await;
                let mut client = tokio::io::join(reader, writer_half);
                if relay_guac(&mut client, &mut guacd, peer).await {
                    park_session(&config, cid.clone(), guacd, peer).await;
                } else {
                    info!(%peer, connection_id = %cid, "guacd session ended");
                }
                return;
            }
            // Grace period expired or unknown id — fall through to new session.
            info!(%peer, connection_id = %cid, "parked session not found — starting new session");
        }

        // ── New session path ──────────────────────────────────────────────────────────

        // ── Recording path (shared by all guac protocols) ────────────────────────────
        // jwt_record is authoritative (server-signed); applies to RDP, VNC, and SSH.
        //
        //   /recordings/
        //     192.168.1.100/   ← guacd writes .guac files here
        //     192.168.1.101/
        let recording_path = if jwt_record {
            match config.guacd_recording_path.as_deref() {
                Some(base) if !base.is_empty() => {
                    let device_dir = format!("{}/{}", base, payload.target);
                    match tokio::fs::create_dir_all(&device_dir).await {
                        Ok(()) => {
                            info!(%peer, dir = %device_dir,
                                "created per-device recording directory");
                        }
                        Err(e) => {
                            warn!(%peer, dir = %device_dir,
                                "could not create per-device recording directory: {e}");
                        }
                    }
                    device_dir
                }
                _ => {
                    warn!(%peer,
                        "recording requested (JWT record=true) but \
                         GUACD_RECORDING_PATH is not configured — recording disabled");
                    String::new()
                }
            }
        } else {
            String::new()
        };

        let params = match payload.application.as_str() {
            "rdp" => {
                // Resolve the effective drive path: the gateway-level default
                // is used when the client opts in; a missing GUACD_DRIVE_PATH
                // silently disables the feature regardless of the flag.
                //
                // When a base path is available, create a per-device sub-
                // directory named after the target IP so that files from
                // different devices never mix, and the origin of every file
                // is unambiguous regardless of which gateway container handled
                // the session.
                //
                //   /guac-drives/
                //     192.168.1.100/          ← device writes here
                //       Downloads/            ← guacd writes here (push to device)
                //     192.168.1.101/
                //       Downloads/
                let drive_path = if payload.enable_drive.unwrap_or(false) {
                    match config.guacd_drive_path.as_deref() {
                        Some(base) if !base.is_empty() => {
                            // IP addresses are safe directory names on Linux
                            // (digits + dots); use as-is for readability.
                            let device_dir = format!("{}/{}", base, payload.target);
                            match tokio::fs::create_dir_all(&device_dir).await {
                                Ok(()) => {
                                    info!(%peer, dir = %device_dir,
                                        "created per-device drive directory");
                                }
                                Err(e) => {
                                    // Non-fatal: guacd will still try to use
                                    // the path; log the error and continue.
                                    warn!(%peer, dir = %device_dir,
                                        "could not create per-device drive directory: {e}");
                                }
                            }
                            device_dir
                        }
                        _ => String::new(),
                    }
                } else {
                    String::new()
                };

                guac::ConnectionParams::Rdp(guac::RdpParams {
                    hostname:    payload.target.clone(),
                    port:        payload.port,
                    username:    payload.username.clone().unwrap_or_default(),
                    password:    payload.password.clone(),
                    width:       payload.width.unwrap_or(1280),
                    height:      payload.height.unwrap_or(800),
                    dpi:         payload.dpi.unwrap_or(96),
                    ignore_cert: true,
                    enable_drive: !drive_path.is_empty(),
                    drive_path,
                    recording_path: recording_path.clone(),
                    ..Default::default()
                })
            }
            "vnc" => guac::ConnectionParams::Vnc(guac::VncParams {
                hostname: payload.target.clone(),
                port:     payload.port,
                username: payload.username.clone().unwrap_or_default(),
                password: payload.password.clone(),
                width:    payload.width.unwrap_or(1280),
                height:   payload.height.unwrap_or(800),
                dpi:      payload.dpi.unwrap_or(96),
                recording_path: recording_path.clone(),
            }),
            "ssh" => guac::ConnectionParams::Ssh(guac::SshParams {
                hostname: payload.target.clone(),
                port:     payload.port,
                username: payload.username.clone().unwrap_or_default(),
                password: payload.password.clone(),
                width:    payload.width.unwrap_or(1280),
                height:   payload.height.unwrap_or(800),
                dpi:      payload.dpi.unwrap_or(96),
                recording_path,
            }),
            other => {
                warn!(%peer, application = %other,
                    "guac mode requested for unsupported application");
                send_line(&mut writer_half, b"400 BAD REQUEST\n").await;
                writer_half.shutdown().await.ok();
                return;
            }
        };

        let session = match guac::connect(&config.guacd_addr, params).await {
            Ok(s) => s,
            Err(e) => {
                error!(%peer, "guacd connect failed: {e}");
                send_line(&mut writer_half, b"502 BAD GATEWAY\n").await;
                writer_half.shutdown().await.ok();
                return;
            }
        };

        info!(%peer,
            connection_id = %session.connection_id,
            "guacd handshake complete — entering Guacamole relay");

        // Include the connection_id in the response so the client can
        // send it back on reconnect.
        let resp = format!("200 CONNECTED {}\n", session.connection_id);
        send_line(&mut writer_half, resp.as_bytes()).await;

        let mut client = tokio::io::join(reader, writer_half);
        let mut guacd  = session.stream;

        debug!(%peer, connection_id = %session.connection_id,
            "entering relay_guac for new session");
        if relay_guac(&mut client, &mut guacd, peer).await {
            // Client disconnected; guacd is still alive — park for reconnect.
            park_session(&config, session.connection_id, guacd, peer).await;
        } else {
            info!(%peer, "Guacamole session ended by guacd");
        }
        return;
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

    if !payload.e2ecrypt.unwrap_or(false) {
        // ── Transform mode: HTTP/1.1-aware reverse proxy ──────────────────
        match payload.application.as_str() {
            "https" | "expert-i" => {
                // Open our own TLS session to the upstream so the gateway
                // can see and transform the plaintext HTTP payload.
                //
                // Prefer `sni` over `target` for the TLS ServerName: `target`
                // is typically a bare IP address, which is not a valid SNI
                // name and breaks name-based virtual hosting on the device.
                let tls_hostname = payload.sni.as_deref().unwrap_or(&payload.target);
                match transform::connect_tls_upstream(
                    target,
                    tls_hostname,
                    config.upstream_tls_accept_invalid_certs,
                )
                .await
                {
                    Ok(tls_target) => {
                        info!(%peer, %target_addr, "proxy mode — TLS upstream");
                        transform::run(client, tls_target, &payload, hook).await;
                    }
                    Err(e) => {
                        error!(%peer, %target_addr, "TLS upstream connect failed: {e}");
                    }
                }
            }
            _ => {
                info!(%peer, %target_addr, "proxy mode — plain upstream");
                transform::run(client, target, &payload, hook).await;
            }
        }
    } else {
        // ── End-to-end encrypted passthrough: raw bidirectional byte relay ─
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

/// Bidirectional relay between `client` and `guacd`.
///
/// Returns `true` if the **client** side closed the connection and guacd is
/// still alive (the session should be parked for reconnect).
/// Returns `false` if **guacd** closed the connection (session ended cleanly).
async fn relay_guac<C, G>(client: &mut C, guacd: &mut G, peer: SocketAddr) -> bool
where
    C: AsyncRead + AsyncWrite + Unpin,
    G: AsyncRead + AsyncWrite + Unpin,
{
    let mut buf_c = vec![0u8; 16_384];
    let mut buf_g = vec![0u8; 16_384];
    let mut iterations: u64 = 0;
    debug!(%peer, "relay_guac: entered bidirectional relay loop");
    loop {
        tokio::select! {
            res = client.read(&mut buf_c) => match res {
                Ok(0) => {
                    debug!(%peer, iterations, "relay_guac: client EOF — parking guacd");
                    return true;
                }
                Err(e) => {
                    debug!(%peer, iterations, error = %e, "relay_guac: client read error — parking guacd");
                    return true;
                }
                Ok(n) => {
                    debug!(%peer, iterations, bytes = n, "relay_guac: client → guacd");
                    if let Err(e) = guacd.write_all(&buf_c[..n]).await {
                        warn!(%peer, iterations, error = %e, "relay_guac: write to guacd failed");
                        return false;
                    }
                }
            },
            res = guacd.read(&mut buf_g) => match res {
                Ok(0) => {
                    debug!(%peer, iterations, "relay_guac: guacd EOF — session ended");
                    return false;
                }
                Err(e) => {
                    debug!(%peer, iterations, error = %e, "relay_guac: guacd read error — session ended");
                    return false;
                }
                Ok(n) => {
                    debug!(%peer, iterations, bytes = n, "relay_guac: guacd → client");
                    if let Err(e) = client.write_all(&buf_g[..n]).await {
                        warn!(%peer, iterations, error = %e, "relay_guac: write to client failed");
                        return true;
                    }
                    // Flush so the client receives the data promptly even
                    // when writes are small (e.g. single guacd instructions).
                    if let Err(e) = client.flush().await {
                        warn!(%peer, iterations, error = %e, "relay_guac: flush to client failed");
                        return true;
                    }
                }
            },
        }
        iterations += 1;
    }
}

/// Park a live guacd stream for `reconnect_grace_secs` seconds.
///
/// If a client reconnects within that window it will find the stream in
/// `config.parked_sessions` and resume the session without a new handshake.
/// If nobody reconnects, the timer task removes the entry and the stream drops.
async fn park_session(
    config:        &Arc<Config>,
    connection_id: String,
    guacd:         TcpStream,
    peer:          SocketAddr,
) {
    let grace = config.reconnect_grace_secs;
    info!(%peer, %connection_id,
        "parking guacd session for {grace}s (client disconnected)");

    let parked = Arc::clone(&config.parked_sessions);
    let id     = connection_id.clone();

    config.parked_sessions.lock().await.insert(connection_id, guacd);

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(grace)).await;
        if parked.lock().await.remove(&id).is_some() {
            info!(connection_id = %id, "parked guacd session expired ({grace}s)");
        }
        // If already removed by a reconnect, this is a silent no-op.
    });
}

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
