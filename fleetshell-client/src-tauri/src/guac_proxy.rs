//! Guacamole WebSocket proxy — bridges the browser (guacamole-common-js) to
//! the fleetshell-gateway's guac mode.
//!
//! # Flow
//!
//! ```text
//! Browser (guacamole-common-js)
//!   │  WebSocket TEXT frames (raw Guacamole instruction text)
//!   ▼
//! /guac-ws?session=<id>  (this module)
//!   │  look up GuacSession, consume it
//!   │  TLS TCP connect to gateway
//!   │  send JSON handshake: { guac: true, target, port, token, ... }
//!   │  read "200 CONNECTED\n"
//!   │  bridge: WS text ↔ raw TCP bytes
//!   │  intercept 0.,4.ping,...; — echo back, never forward to gateway
//!   ▼
//! fleetshell-gateway (guac branch in handler.rs)
//!   │  connects to local guacd, runs select→args→connect→ready
//!   ▼
//! guacd → RDP/VNC device
//! ```

use axum::{
	extract::{
		Query,
		State,
		ws::{Message, WebSocket, WebSocketUpgrade},
	},
	http::StatusCode,
	response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::server::ApiState;

// ── Pending session record ────────────────────────────────────────────────────

/// Connection parameters for one pending Guacamole session.
///
/// Created by `tunnel_handler` when `guac: true` is set, stored in
/// `ApiState::guac_sessions`, and consumed by [`guac_ws_handler`] the moment
/// the browser opens the WebSocket.
#[derive(Debug, Clone)]
pub struct GuacSession {
	pub target:   String,
	pub port:     u16,
	pub token:    String,
	pub protocol: String,
	pub username: String,
	/// Never logged.
	pub password: String,
	pub width:    u32,
	pub height:   u32,
	pub dpi:      u32,
	pub gateway:  String,
}

// ── WebSocket upgrade handler (axum route) ────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct GuacWsParams {
	session: String,
}

/// `GET /guac-ws?session=<id>`
///
/// Upgrades to WebSocket (subprotocol `guacamole`), looks up the pending
/// session record, then hands off to [`handle_guac_ws`].
pub async fn guac_ws_handler(
	ws:            WebSocketUpgrade,
	State(state):  State<ApiState>,
	Query(params): Query<GuacWsParams>,
) -> impl IntoResponse {
	// Look up — and immediately remove — the pending session so it can only
	// be claimed once.
	let session = state.guac_sessions
		.write().await
		.remove(&params.session);

	let session = match session {
		Some(s) => s,
		None    => {
			log::warn!("guac-ws: unknown session id '{}'", params.session);
			return StatusCode::NOT_FOUND.into_response();
		}
	};

	log::info!(
		"guac-ws: session {} accepted -- target={}:{} protocol={}",
		params.session, session.target, session.port, session.protocol,
	);

	ws.protocols(["guacamole"])
		.on_upgrade(move |socket| handle_guac_ws(socket, session, state))
		.into_response()
}

// ── Inner handler ─────────────────────────────────────────────────────────────

async fn handle_guac_ws(socket: WebSocket, session: GuacSession, state: ApiState) {
	let (gw_host, gw_port) = crate::tunnel::parse_gateway(&session.gateway);
	let gw_addr = format!("{}:{}", gw_host, gw_port);

	// ── 1. TCP connect to gateway ─────────────────────────────────────────
	let tcp = match tokio::net::TcpStream::connect(&gw_addr).await {
		Ok(s)  => s,
		Err(e) => {
			log::error!("guac-ws: gateway TCP connect failed ({}): {}", gw_addr, e);
			return;
		}
	};

	// ── 2. TLS handshake ──────────────────────────────────────────────────
	let connector = match crate::tunnel::make_tls_connector() {
		Ok(c)  => c,
		Err(e) => {
			log::error!("guac-ws: TLS setup failed: {}", e);
			return;
		}
	};

	let server_name = match rustls::pki_types::ServerName::try_from(gw_host.as_str()) {
		Ok(n)  => n.to_owned(),
		Err(e) => {
			log::error!("guac-ws: invalid gateway hostname '{}': {}", gw_host, e);
			return;
		}
	};

	let mut tls = match connector.connect(server_name, tcp).await {
		Ok(s)  => s,
		Err(e) => {
			log::error!("guac-ws: TLS handshake failed: {}", e);
			return;
		}
	};

	// ── 3. Send gateway JSON handshake ────────────────────────────────────
	let payload = build_gateway_payload(&session, &state.gateway_path);
	if let Err(e) = tls.write_all(&payload).await {
		log::error!("guac-ws: handshake write failed: {}", e);
		return;
	}
	if let Err(e) = tls.flush().await {
		log::error!("guac-ws: handshake flush failed: {}", e);
		return;
	}

	// ── 4. Read gateway status line ───────────────────────────────────────
	let status = match crate::tunnel::read_line(&mut tls, 1024).await {
		Ok(s)  => s,
		Err(e) => {
			log::error!("guac-ws: failed to read gateway status: {}", e);
			return;
		}
	};
	let upper = status.trim().to_uppercase();
	log::info!("guac-ws: gateway status '{}'", status.trim());

	if upper.starts_with("401") || upper.starts_with("403") {
		log::error!("guac-ws: gateway auth rejected: {}", status.trim());
		return;
	}
	if !upper.starts_with("200") || !upper.contains("CONNECTED") {
		log::error!("guac-ws: gateway refused: {}", status.trim());
		return;
	}

	// ── 5. Bridge WebSocket ↔ TLS TCP ─────────────────────────────────────
	log::info!("guac-ws: relay started — target={}:{}", session.target, session.port);
	bridge(socket, tls).await;
	log::info!("guac-ws: relay ended — target={}:{}", session.target, session.port);
}

// ── Bridge ────────────────────────────────────────────────────────────────────

/// Bridge a browser WebSocket to the raw TCP stream returned by the gateway
/// after `200 CONNECTED`.
///
/// The Guacamole protocol is text-based: the browser sends `TEXT` frames
/// whose payload is one or more Guacamole instructions, and receives the
/// same from the gateway side.  No WebSocket framing changes are needed
/// on the gateway side — raw bytes in = raw bytes out.
///
/// # Ping intercept
///
/// guacamole-common-js sends a keepalive every 500 ms:
/// `0.,4.ping,<timestamp>;`
///
/// The opcode is the empty string (`0.`).  This must be **echoed back to the
/// browser** and **not forwarded to the gateway or guacd** — without the echo
/// the browser marks the tunnel UNSTABLE after ~1.5 s and closes it after 15 s.
async fn bridge<G>(socket: WebSocket, gateway: G)
where
	G: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
	let (gw_r, mut gw_w) = tokio::io::split(gateway);
	let mut gw_r = tokio::io::BufReader::new(gw_r);

	let (mut ws_tx, mut ws_rx) = socket.split();

	// Channel that merges two sources of outgoing browser messages:
	//   • ping echoes (browser→gateway direction intercepts them here)
	//   • drawing instructions (gateway→browser direction sends here)
	let (to_browser, mut from_senders) =
		tokio::sync::mpsc::unbounded_channel::<String>();

	// ── Task A: gateway → browser ─────────────────────────────────────────────────────
	//
	// guacamole-common-js requires every WebSocket TEXT message to end at
	// a complete Guacamole instruction boundary (i.e. at a ';').  A raw
	// read() call returns an arbitrary byte count that can split an
	// instruction mid-stream; the browser parser then fails with
	// "Incomplete instruction".  We accumulate in `carry` and only flush
	// up to the last complete instruction boundary per read.
	let gw_tx = to_browser.clone();
	let gw_task = tokio::spawn(async move {
		let mut buf   = vec![0u8; 65536];
		let mut carry: Vec<u8> = Vec::new();
		loop {
			match gw_r.read(&mut buf).await {
				Ok(0) | Err(_) => break,
				Ok(n) => {
					carry.extend_from_slice(&buf[..n]);
					if let Some(end) = last_instruction_end(&carry) {
						let to_send: Vec<u8> = carry.drain(..end).collect();
						let text = String::from_utf8_lossy(&to_send).into_owned();
						if gw_tx.send(text).is_err() { break; }
					}
					// Partial tail stays in carry for the next read.
				}
			}
		}
	});

	// ── Task B: browser → gateway (with ping intercept) ───────────────────
	let ping_tx = to_browser.clone();
	let browser_task = tokio::spawn(async move {
		while let Some(msg) = ws_rx.next().await {
			match msg {
				Ok(Message::Text(text)) => {
					if is_guac_ping(&text) {
						// Echo ping back without forwarding.
						ping_tx.send(text.to_string()).ok();
						continue;
					}
					if gw_w.write_all(text.as_bytes()).await.is_err() { break; }
					if gw_w.flush().await.is_err() { break; }
				}
				Ok(Message::Binary(b)) => {
					// Guacamole should only use text frames; handle binary
					// defensively by forwarding raw bytes.
					if gw_w.write_all(&b).await.is_err() { break; }
					if gw_w.flush().await.is_err() { break; }
				}
				Ok(Message::Close(_)) | Err(_) => break,
				_ => {} // Ping/Pong handled by axum automatically.
			}
		}
	});

	// Drop the spare sender so the channel closes when both tasks end.
	drop(to_browser);

	// ── Main loop: forward merged output to the browser ───────────────────
	while let Some(text) = from_senders.recv().await {
		if ws_tx.send(Message::Text(text.into())).await.is_err() {
			break;
		}
	}

	gw_task.abort();
	browser_task.abort();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Find the byte offset just past the last **complete** Guacamole instruction
/// in `buf`, or `None` if no complete instruction is present.
///
/// Walks the buffer using the Guacamole length-prefix wire format so that `;`
/// characters inside element values (e.g. in base64 image blobs) are never
/// mistaken for instruction terminators.
fn last_instruction_end(buf: &[u8]) -> Option<usize> {
	let mut last_end: Option<usize> = None;
	let mut pos = 0usize;

	loop {
		// Try to parse one complete instruction starting at `pos`.
		loop {
			// ── length prefix (decimal digits terminated by '.') ──────────────
			let len_start = pos;
			while pos < buf.len() && buf[pos].is_ascii_digit() {
				pos += 1;
			}
			if pos == len_start || pos >= buf.len() || buf[pos] != b'.' {
				return last_end; // incomplete or malformed
			}
			let len: usize = match std::str::from_utf8(&buf[len_start..pos])
				.ok()
				.and_then(|s| s.parse().ok())
			{
				Some(n) => n,
				None    => return last_end,
			};
			pos += 1; // skip '.'

			// ── element value (exactly `len` bytes) ──────────────────────────
			if pos + len > buf.len() {
				return last_end; // value incomplete
			}
			pos += len;

			// ── separator: ',' more elements | ';' end of instruction ──────
			if pos >= buf.len() {
				return last_end;
			}
			match buf[pos] {
				b',' => { pos += 1; } // another element follows
				b';' => {
					pos += 1;
					last_end = Some(pos); // instruction complete
					break; // inner loop: try next instruction
				}
				_ => return last_end, // malformed byte
			}
		}
		// Outer loop: attempt the next instruction.
	}
}

/// Returns `true` if `text` is a Guacamole tunnel keepalive ping.
///
/// guacamole-common-js sends `0.,4.ping,<timestamp>;` every 500 ms using the
/// empty-string opcode (internal data channel).  It must be echoed back and
/// must not be forwarded to guacd.
fn is_guac_ping(text: &str) -> bool {
	text.starts_with("0.,4.ping,")
}

/// Build the newline-terminated JSON handshake line sent to the gateway.
fn build_gateway_payload(session: &GuacSession, gateway_path: &str) -> Vec<u8> {
	let json = serde_json::json!({
		"target":      session.target,
		"application": session.protocol,
		"port":        session.port,
		"token":       session.token,
		"guac":        true,
		"username":    session.username,
		"password":    session.password,
		"width":       session.width,
		"height":      session.height,
		"dpi":         session.dpi,
		"gateway":     session.gateway,
		"path":        gateway_path,
		"e2ecrypt":    false,
	});
	let mut bytes = json.to_string().into_bytes();
	bytes.push(b'\n');
	bytes
}
