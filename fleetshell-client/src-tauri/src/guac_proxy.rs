//! Guacamole slot server and WebSocket proxy.
//!
//! Each guac session claims a slot IP (127.0.0.x) from the SlotManager and
//! binds its own HTTP/WebSocket server on that IP:port.  The slot is
//! displayed in the Functions tab, monitored by the idle timer, and released
//! on disconnect or timeout — exactly like raw TCP tunnel sessions.
//!
//! # Architecture
//!
//! ```text
//! Portal → POST /api/tunnel (guac:true, target=172.16.28.109, port=3389)
//!
//!   tunnel_handler
//!     → SlotManager::claim()          → slot 0 (127.0.0.2)
//!     → TcpListener::bind(127.0.0.2:3389)
//!     → spawn run_guac_slot()         (per-slot HTTP/WS server)
//!     → spawn run_idle_monitor()
//!     → emit slot-update active
//!     → return wss://127-0-0-2.client.fleetshell.com:3389/guac-ws
//!
//!   Browser connects to that URL
//!     → run_guac_slot() accepts TCP, handles TLS, upgrades WebSocket
//!     → guac_ws_handler() → handle_guac_ws() → bridge()
//!
//!   bridge()
//!     → TLS connect to gateway
//!     → JSON handshake { guac:true, ... }
//!     → 200 CONNECTED
//!     → relay WS text ↔ raw TCP bytes (last_active updated on every read)
//!
//!   On idle timeout or tab close:
//!     → task_handles abort() kills run_guac_slot (and any live session)
//!     → slot released, Functions tab updated
//! ```

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::{
	Router,
	extract::{
		State,
		ws::{Message, WebSocket, WebSocketUpgrade},
	},
	response::IntoResponse,
	routing::get as ws_upgrade,
};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower_http::cors::CorsLayer;

use crate::server::ApiState;
use tauri::Manager as _;  // for AppHandle::state()

// ── Session parameters ────────────────────────────────────────────────────────

/// All parameters needed to open a Guacamole session.
/// Stored in the per-slot axum router's State; no separate session map needed.
#[derive(Debug)]
pub struct GuacSessionParams {
	pub target:   String,
	/// Target service port forwarded to the gateway (e.g. 22 for SSH).
	pub port:     u16,
	/// Local WebSocket listener port on the slot IP.
	/// Equals `port` for most protocols; remapped for browser-blocked ports
	/// (e.g. SSH 22 → 8022).
	pub ws_port:  u16,
	pub token:    String,
	pub protocol: String,
	pub username: String,
	/// Never logged.
	pub password:    String,
	pub width:       u32,
	pub height:      u32,
	pub dpi:         u32,
	pub gateway:     String,
	/// Slot index — for log messages and Tauri events.
	pub slot_idx:    usize,
	/// Shared with the idle monitor; updated on every byte that flows.
	pub last_active: Arc<std::sync::atomic::AtomicU64>,
}

// ── Per-slot router state ─────────────────────────────────────────────────────

#[derive(Clone)]
struct GuacRouterState {
	params:              Arc<GuacSessionParams>,
	api_state:           ApiState,
	/// Persists the guacd connection_id across WebSocket reconnects for
	/// this slot.  `None` = first connection; `Some` = reconnect.
	live_connection_id:  Arc<tokio::sync::Mutex<Option<String>>>,
}

// ── Per-slot router ───────────────────────────────────────────────────────────

fn build_guac_router(
	params:             Arc<GuacSessionParams>,
	api_state:          ApiState,
	live_connection_id: Arc<tokio::sync::Mutex<Option<String>>>,
) -> Router {
	Router::new()
		.route("/guac-ws", ws_upgrade(guac_ws_handler))
		.layer(CorsLayer::permissive())
		.with_state(GuacRouterState { params, api_state, live_connection_id })
}

// ── Per-slot server ───────────────────────────────────────────────────────────

/// Accept connections on `listener` and serve the Guacamole WebSocket handler.
///
/// The entire accept loop and every connection it spawns run within the calling
/// task.  When the idle monitor aborts the task handle, both the listener and
/// any active WebSocket session are cancelled immediately — no lingering tasks.
pub async fn run_guac_slot(
	listener:  tokio::net::TcpListener,
	params:    Arc<GuacSessionParams>,
	api_state: ApiState,
) {
	let tls_state = api_state.app
		.state::<crate::server::TlsState>()
		.0.clone();

	// Persists the guacd connection_id returned by the gateway across
	// WebSocket reconnects so the gateway can resume the parked session.
	let live_connection_id: Arc<tokio::sync::Mutex<Option<String>>> =
		Arc::new(tokio::sync::Mutex::new(None));

	log::info!(
		"guac slot {} — {}:{} (target port {})",
		params.slot_idx,
		crate::tunnel::dns_host(
			&crate::slot::slot_ip(params.slot_idx)
		),
		params.ws_port,
		params.port,
	);

	loop {
		let (stream, peer_addr) = match listener.accept().await {
			Ok(p)  => p,
			Err(e) => { log::error!("guac slot {} accept error: {}", params.slot_idx, e); break; }
		};

		let acceptor_opt = tls_state.read().await.clone();
		let router       = build_guac_router(
			params.clone(),
			api_state.clone(),
			live_connection_id.clone(),
		);

		match acceptor_opt {
			Some(acceptor) => {
				match acceptor.accept(stream).await {
					Ok(tls) => crate::server::serve_connection(
						hyper_util::rt::TokioIo::new(tls), router, peer_addr,
					).await,
					Err(e) => log::warn!("guac slot {} TLS failed: {}", params.slot_idx, e),
				}
			}
			None => {
				crate::server::serve_connection(
					hyper_util::rt::TokioIo::new(stream), router, peer_addr,
				).await;
			}
		}
	}
}
// ── WebSocket upgrade handler ─────────────────────────────────────────────────

async fn guac_ws_handler(
	ws:           WebSocketUpgrade,
	State(state): State<GuacRouterState>,
) -> impl IntoResponse {
	log::info!(
		"guac slot {} — browser connected (target={}:{})",
		state.params.slot_idx, state.params.target, state.params.port,
	);
	ws.protocols(["guacamole"])
		.on_upgrade(move |socket| {
			handle_guac_ws(
				socket,
				state.params,
				state.api_state,
				state.live_connection_id,
			)
		})
		.into_response()
}

// ── Inner handler ─────────────────────────────────────────────────────────────

async fn handle_guac_ws(
	socket:             WebSocket,
	params:             Arc<GuacSessionParams>,
	api_state:          ApiState,
	live_connection_id: Arc<tokio::sync::Mutex<Option<String>>>,
) {
	use std::sync::atomic::Ordering;

	let (gw_host, gw_port) = crate::tunnel::parse_gateway(&params.gateway);
	let gw_addr = format!("{}:{}", gw_host, gw_port);

	// ── TLS connect to gateway ────────────────────────────────────────────────────────
	let tcp = match tokio::net::TcpStream::connect(&gw_addr).await {
		Ok(s)  => s,
		Err(e) => { log::error!("guac slot {} gateway TCP failed ({}): {}", params.slot_idx, gw_addr, e); return; }
	};
	let connector = match crate::tunnel::make_tls_connector() {
		Ok(c)  => c,
		Err(e) => { log::error!("guac slot {} TLS setup failed: {}", params.slot_idx, e); return; }
	};
	let server_name = match rustls::pki_types::ServerName::try_from(gw_host.as_str()) {
		Ok(n)  => n.to_owned(),
		Err(e) => { log::error!("guac slot {} invalid gateway hostname \'{}\': {}", params.slot_idx, gw_host, e); return; }
	};
	let mut tls = match connector.connect(server_name, tcp).await {
		Ok(s)  => s,
		Err(e) => { log::error!("guac slot {} TLS handshake failed: {}", params.slot_idx, e); return; }
	};

	// ── Gateway JSON handshake ────────────────────────────────────────────────────────
	// Read any existing connection_id from the slot state (set by a
	// previous WebSocket session on this slot).
	let current_cid = live_connection_id.lock().await.clone();
	let payload = build_gateway_payload(&params, &api_state.gateway_path, current_cid.as_deref());
	if tls.write_all(&payload).await.is_err() || tls.flush().await.is_err() {
		log::error!("guac slot {} handshake write failed", params.slot_idx);
		return;
	}

	// ── Read gateway status ─────────────────────────────────────────────────────────
	// New response format: "200 CONNECTED $uuid"
	// The connection_id is stored so the next WebSocket can reconnect.
	let status = match crate::tunnel::read_line(&mut tls, 1024).await {
		Ok(s)  => s,
		Err(e) => { log::error!("guac slot {} failed to read gateway status: {}", params.slot_idx, e); return; }
	};
	let upper = status.trim().to_uppercase();
	log::info!("guac slot {} gateway: '{}'", params.slot_idx, status.trim());

	if upper.starts_with("401") || upper.starts_with("403") {
		log::error!("guac slot {} gateway auth rejected: {}", params.slot_idx, status.trim());
		return;
	}
	if !upper.starts_with("200") || !upper.contains("CONNECTED") {
		log::error!("guac slot {} gateway refused: {}", params.slot_idx, status.trim());
		return;
	}

	// Parse connection_id from "200 CONNECTED $uuid" and persist it for
	// the next WebSocket session on this slot (reconnect).
	if let Some(cid) = status.trim().split_whitespace().nth(2).map(String::from) {
		log::info!("guac slot {} connection_id={}", params.slot_idx, cid);
		*live_connection_id.lock().await = Some(cid);
	}

	// ── Bridge ──────────────────────────────────────────────────────────────
	log::info!("guac slot {} relay started", params.slot_idx);
	bridge(socket, tls, params.last_active.clone()).await;
	log::info!("guac slot {} relay ended", params.slot_idx);

	// Reset the idle clock so the reconnect window is a full idle_timeout
	// period, regardless of how long the previous session was idle.
	params.last_active.store(crate::slot::now_secs(), Ordering::Relaxed);
}
// ── Bridge ────────────────────────────────────────────────────────────────────

/// Bridge a browser WebSocket to the raw TCP stream from the gateway.
///
/// Every byte that flows updates `last_active` so the idle monitor sees
/// real traffic and does not time out an active session.
///
/// # Instruction-boundary flushing
///
/// guacamole-common-js requires every WebSocket TEXT message to end at a
/// complete Guacamole instruction (`…;`).  Raw reads return arbitrary byte
/// counts that can split instructions mid-stream.  We buffer in `carry` and
/// only send complete instructions per WebSocket message.
///
/// # Ping intercept
///
/// guacamole-common-js sends `0.,4.ping,<ts>;` every 500 ms.  This must be
/// echoed back to the browser and NOT forwarded to the gateway/guacd.
async fn bridge<G>(socket: WebSocket, gateway: G, last_active: Arc<std::sync::atomic::AtomicU64>)
where
	G: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
	let (gw_r, mut gw_w) = tokio::io::split(gateway);
	let mut gw_r = tokio::io::BufReader::new(gw_r);

	let (mut ws_tx, mut ws_rx) = socket.split();

	let (to_browser, mut from_senders) =
		tokio::sync::mpsc::unbounded_channel::<String>();

	// ── Task A: gateway → browser ─────────────────────────────────────────
	let gw_tx        = to_browser.clone();
	let last_active_a = last_active.clone();
	let gw_task = tokio::spawn(async move {
		let mut buf   = vec![0u8; 65536];
		let mut carry: Vec<u8> = Vec::new();
		loop {
			match gw_r.read(&mut buf).await {
				Ok(0) | Err(_) => break,
				Ok(n) => {
					last_active_a.store(crate::slot::now_secs(), Ordering::Relaxed);
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
	let ping_tx       = to_browser.clone();
	let last_active_b = last_active.clone();
	let browser_task = tokio::spawn(async move {
		while let Some(msg) = ws_rx.next().await {
			match msg {
				Ok(Message::Text(text)) => {
					last_active_b.store(crate::slot::now_secs(), Ordering::Relaxed);
					if is_guac_ping(&text) {
						ping_tx.send(text.to_string()).ok();
						continue;
					}
					if gw_w.write_all(text.as_bytes()).await.is_err() { break; }
					if gw_w.flush().await.is_err() { break; }
				}
				Ok(Message::Binary(b)) => {
					if gw_w.write_all(&b).await.is_err() { break; }
					if gw_w.flush().await.is_err() { break; }
				}
				Ok(Message::Close(_)) | Err(_) => break,
				_ => {}
			}
		}
	});

	drop(to_browser);

	while let Some(text) = from_senders.recv().await {
		if ws_tx.send(Message::Text(text.into())).await.is_err() { break; }
	}

	gw_task.abort();
	browser_task.abort();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Find the byte offset just past the last complete Guacamole instruction in
/// `buf`, using length-prefix parsing so `;` inside values is never mistaken
/// for a terminator.
fn last_instruction_end(buf: &[u8]) -> Option<usize> {
	let mut last_end: Option<usize> = None;
	let mut pos = 0usize;
	loop {
		loop {
			let len_start = pos;
			while pos < buf.len() && buf[pos].is_ascii_digit() { pos += 1; }
			if pos == len_start || pos >= buf.len() || buf[pos] != b'.' { return last_end; }
			let len: usize = match std::str::from_utf8(&buf[len_start..pos]).ok().and_then(|s| s.parse().ok()) {
				Some(n) => n, None => return last_end,
			};
			pos += 1;
			if pos + len > buf.len() { return last_end; }
			pos += len;
			if pos >= buf.len() { return last_end; }
			match buf[pos] {
				b',' => { pos += 1; }
				b';' => { pos += 1; last_end = Some(pos); break; }
				_    => return last_end,
			}
		}
	}
}

/// `true` if `text` is a Guacamole keepalive ping — must be echoed, never forwarded.
fn is_guac_ping(text: &str) -> bool {
	text.starts_with("0.,4.ping,")
}

/// Build the newline-terminated JSON handshake sent to the gateway.
fn build_gateway_payload(
	params:        &GuacSessionParams,
	gateway_path:  &str,
	connection_id: Option<&str>,
) -> Vec<u8> {
	let json = serde_json::json!({
		"target":        params.target,
		"application":   params.protocol,
		"port":          params.port,
		"token":         params.token,
		"guac":          true,
		"username":      params.username,
		"password":      params.password,
		"width":         params.width,
		"height":        params.height,
		"dpi":           params.dpi,
		"gateway":       params.gateway,
		"path":          gateway_path,
		"e2ecrypt":      false,
		"connection_id": connection_id,
	});
	let mut bytes = json.to_string().into_bytes();
	bytes.push(b'\n');
	bytes
}
