//! SSH direct WebSocket proxy.
//!
//! Mirrors the structure of `guac_proxy` but is deliberately simpler:
//! there is no Guacamole framing, no instruction-boundary detection, no
//! ping intercept, and no session parking / reconnect — the gateway's SSH
//! handler owns the SSH state and tears it down when the connection closes.
//!
//! # Architecture
//!
//! ```text
//! Portal → POST /api/tunnel (application:"ssh", guac:false, target, port:22 …)
//!
//!   tunnel_handler
//!     → SlotManager::claim()               → slot N (127.0.0.(N+2))
//!     → TcpListener::bind(slot_ip:ws_port)
//!     → spawn run_ssh_slot()               (per-slot HTTP/WS server)
//!     → spawn run_idle_monitor()
//!     → emit slot-update active
//!     → return wss://127-0-0-N.client.fleetshell.com:ws_port/ssh-ws
//!
//!   Browser (xterm.js) connects to that URL
//!     → run_ssh_slot() accepts TCP, handles TLS, upgrades WebSocket
//!     → ssh_ws_handler() → handle_ssh_ws() → bridge()
//!
//!   bridge()
//!     → TLS/plain connect to gateway
//!     → JSON handshake { application:"ssh", guac:false, … }
//!     → "200 CONNECTED\n"
//!     → relay WS binary ↔ raw TCP bytes (last_active updated on every read)
//! ```
//!
//! # Wire protocol (after 200 CONNECTED)
//!
//! The bridge copies bytes verbatim in both directions.  Framing is the
//! responsibility of the gateway (`ssh.rs`) and the browser (`session/+page.svelte`):
//!
//! **Browser → gateway** (keyboard input / resize frames):
//! ```text
//! [0x00][len_hi][len_lo][...data]             keyboard input
//! [0x01][0x00][0x04][rows_hi][rows_lo][cols_hi][cols_lo]   PTY resize
//! ```
//!
//! **Gateway → browser** (raw PTY output):
//! ```text
//! raw bytes — no framing
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
use tauri::Manager as _;

// ── Parameters ────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SshProxyParams {
	/// Target device hostname or IP.
	pub target:       String,
	/// SSH port on the device (typically 22).
	pub port:         u16,
	/// Local WebSocket listener port on the slot IP.
	/// Port 22 is browser-blocked, so it is remapped to 50022 via
	/// `crate::server::guac_ws_port()`.
	pub ws_port:      u16,
	/// JWT forwarded verbatim to the gateway.
	pub token:        String,
	/// SSH username.
	pub username:     String,
	/// SSH password.  Never logged.
	pub password:     String,
	/// Display width (pixels) — used by the gateway to compute initial PTY cols.
	pub width:        u32,
	/// Display height (pixels) — used by the gateway to compute initial PTY rows.
	pub height:       u32,
	/// Gateway address ("host" or "host:port").
	pub gateway:      String,
	/// Slot index for log messages and Tauri slot-update events.
	pub slot_idx:     usize,
	/// Shared with the idle monitor; bumped on every byte that flows.
	pub last_active:  Arc<std::sync::atomic::AtomicU64>,
	/// Skip TLS certificate validation for the outbound gateway connection.
	pub skip_tls_verify: bool,
	/// Disable TLS entirely for the outbound gateway connection (plain TCP).
	pub disable_tls:     bool,
	/// Offer the local SSH agent for public-key auth to the target.
	pub agent_enable:    bool,
	/// Configured agent endpoint (empty = OS default; resolved at connect time).
	pub agent_socket:    String,
}

// ── Router state ──────────────────────────────────────────────────────────────

#[derive(Clone)]
struct SshRouterState {
	params:    Arc<SshProxyParams>,
	api_state: ApiState,
}

// ── Per-slot router ───────────────────────────────────────────────────────────

fn build_ssh_router(params: Arc<SshProxyParams>, api_state: ApiState) -> Router {
	Router::new()
		.route("/ssh-ws", ws_upgrade(ssh_ws_handler))
		.layer(CorsLayer::permissive())
		.with_state(SshRouterState { params, api_state })
}

// ── Per-slot accept loop ──────────────────────────────────────────────────────

/// Accept connections on `listener` and serve the SSH WebSocket handler.
///
/// When the idle monitor aborts this task's `JoinHandle`, the listener drops
/// immediately and any active WebSocket session is cancelled — no cleanup needed.
pub async fn run_ssh_slot(
	listener:  tokio::net::TcpListener,
	params:    Arc<SshProxyParams>,
	api_state: ApiState,
) {
	let tls_state = api_state.app
		.state::<crate::server::TlsState>()
		.0.clone();

	log::info!(
		"ssh slot {} — {}:{} → target {}:{}",
		params.slot_idx,
		crate::tunnel::dns_host(&crate::slot::slot_ip(params.slot_idx)),
		params.ws_port,
		params.target,
		params.port,
	);

	loop {
		let (stream, peer_addr) = match listener.accept().await {
			Ok(p)  => p,
			Err(e) => {
				log::error!("ssh slot {} accept error: {}", params.slot_idx, e);
				break;
			}
		};

		let acceptor_opt = tls_state.read().await.clone();
		let router = build_ssh_router(params.clone(), api_state.clone());

		match acceptor_opt {
			Some(acceptor) => match acceptor.accept(stream).await {
				Ok(tls) => crate::server::serve_connection(
					hyper_util::rt::TokioIo::new(tls), router, peer_addr,
				).await,
				Err(e) => log::warn!("ssh slot {} TLS failed: {}", params.slot_idx, e),
			},
			None => crate::server::serve_connection(
				hyper_util::rt::TokioIo::new(stream), router, peer_addr,
			).await,
		}
	}
}

// ── WebSocket upgrade ─────────────────────────────────────────────────────────

async fn ssh_ws_handler(
	ws:           WebSocketUpgrade,
	State(state): State<SshRouterState>,
) -> impl IntoResponse {
	log::info!(
		"ssh slot {} — browser connected (target={}:{})",
		state.params.slot_idx, state.params.target, state.params.port,
	);
	ws.on_upgrade(move |socket| handle_ssh_ws(socket, state.params, state.api_state))
		.into_response()
}

// ── Inner handler ─────────────────────────────────────────────────────────────

async fn handle_ssh_ws(
	socket:    WebSocket,
	params:    Arc<SshProxyParams>,
	api_state: ApiState,
) {
	// ── Optional: open the local SSH agent before the handshake ─────────────────
	// We only advertise `agent:true` to the gateway when the agent is actually
	// reachable, so the gateway never waits for agent traffic that won't come.
	let mut agent: Option<crate::agent_proxy::AgentTransport> = None;
	if params.agent_enable {
		match crate::config::resolve_agent_socket(&params.agent_socket) {
			Some(sock) => match crate::agent_proxy::open_agent(&sock).await {
				Ok(a) => {
					log::info!("ssh slot {} SSH agent ready ({})", params.slot_idx, sock);
					agent = Some(a);
				}
				Err(e) => log::warn!(
					"ssh slot {} cannot open SSH agent ({}): {} — continuing without agent",
					params.slot_idx, sock, e),
			},
			None => log::warn!(
				"ssh slot {} SSH agent enabled but no endpoint resolved — continuing without agent",
				params.slot_idx),
		}
	}
	let use_agent = agent.is_some();

	let (gw_host, gw_port) = crate::tunnel::parse_gateway(&params.gateway);
	let gw_addr = format!("{}:{}", gw_host, gw_port);

	// ── Connect to gateway ────────────────────────────────────────────────────
	let mut gw = match crate::tunnel::connect_gateway(
		&gw_addr,
		&gw_host,
		params.skip_tls_verify,
		params.disable_tls,
	).await {
		Ok(s)  => s,
		Err(e) => {
			log::error!("ssh slot {} gateway connect failed: {}", params.slot_idx, e);
			return;
		}
	};

	// ── JSON handshake ────────────────────────────────────────────────────────
	let payload = build_handshake(&params, &api_state.gateway_path, use_agent);
	if gw.write_all(&payload).await.is_err() || gw.flush().await.is_err() {
		log::error!("ssh slot {} handshake write failed", params.slot_idx);
		return;
	}

	// ── Authentication phase / status line ────────────────────────────────────
	// In agent mode the gateway multiplexes the ssh-agent protocol in-band and
	// sends the status line only once authentication resolves; otherwise the
	// status line arrives immediately.
	let status = if let Some(mut a) = agent {
		match crate::agent_proxy::run_agent_auth_phase(&mut gw, &mut a, params.slot_idx).await {
			Ok(s)  => s,
			Err(e) => {
				log::error!("ssh slot {} agent auth phase failed: {}", params.slot_idx, e);
				return;
			}
		}
	} else {
		match crate::tunnel::read_line(&mut gw, 256).await {
			Ok(s)  => s,
			Err(e) => {
				log::error!("ssh slot {} failed to read gateway status: {}", params.slot_idx, e);
				return;
			}
		}
	};

	let upper = status.trim().to_uppercase();
	log::info!("ssh slot {} gateway: '{}' (agent={})", params.slot_idx, status.trim(), use_agent);

	if upper.starts_with("401") || upper.starts_with("403") {
		log::error!("ssh slot {} gateway auth rejected: {}", params.slot_idx, status.trim());
		return;
	}
	if !upper.starts_with("200") || !upper.contains("CONNECTED") {
		log::error!("ssh slot {} gateway refused: {}", params.slot_idx, status.trim());
		return;
	}

	// ── Raw binary bridge ─────────────────────────────────────────────────────
	log::info!("ssh slot {} relay started", params.slot_idx);
	bridge(socket, gw, params.last_active.clone()).await;
	log::info!("ssh slot {} relay ended", params.slot_idx);

	params.last_active.store(crate::slot::now_secs(), Ordering::Relaxed);
}

// ── Bridge ────────────────────────────────────────────────────────────────────

/// Bidirectional raw-byte bridge between the browser WebSocket and the
/// gateway TCP stream.
///
/// Unlike the Guacamole bridge, there is no instruction-boundary detection
/// and no text/binary distinction — everything flows as `Message::Binary`.
/// The framing protocol lives in the gateway (`ssh.rs`) and the browser
/// (`session/+page.svelte`); this bridge is transparent to it.
async fn bridge<G>(
	socket:      WebSocket,
	gateway:     G,
	last_active: Arc<std::sync::atomic::AtomicU64>,
)
where
	G: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
	let (gw_r, mut gw_w) = tokio::io::split(gateway);
	let (mut ws_tx, mut ws_rx) = socket.split();

	let (to_browser_tx, mut to_browser_rx) =
		tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

	// ── Task A: gateway → browser ─────────────────────────────────────────────
	let tx_a         = to_browser_tx.clone();
	let last_active_a = last_active.clone();
	let gw_task = tokio::spawn(async move {
		let mut buf = vec![0u8; 65536];
		let mut gw_r = tokio::io::BufReader::new(gw_r);
		loop {
			match gw_r.read(&mut buf).await {
				Ok(0) | Err(_) => break,
				Ok(n) => {
					last_active_a.store(crate::slot::now_secs(), Ordering::Relaxed);
					if tx_a.send(buf[..n].to_vec()).is_err() {
						break;
					}
				}
			}
		}
	});

	// ── Task B: browser → gateway ─────────────────────────────────────────────
	let last_active_b = last_active.clone();
	let browser_task = tokio::spawn(async move {
		while let Some(msg) = ws_rx.next().await {
			match msg {
				Ok(Message::Binary(data)) => {
					last_active_b.store(crate::slot::now_secs(), Ordering::Relaxed);
					if gw_w.write_all(&data).await.is_err() { break; }
					if gw_w.flush().await.is_err() { break; }
				}
				Ok(Message::Text(text)) => {
					// xterm.js sends binary frames only; guard against stray text.
					last_active_b.store(crate::slot::now_secs(), Ordering::Relaxed);
					if gw_w.write_all(text.as_bytes()).await.is_err() { break; }
					if gw_w.flush().await.is_err() { break; }
				}
				Ok(Message::Close(_)) | Err(_) => break,
				_ => {} // ping/pong — ignore
			}
		}
	});

	drop(to_browser_tx);

	// Forward gateway output to the browser WebSocket.
	while let Some(data) = to_browser_rx.recv().await {
		if ws_tx.send(Message::Binary(data.into())).await.is_err() {
			break;
		}
	}

	gw_task.abort();
	browser_task.abort();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Build the newline-terminated JSON handshake sent to the gateway.
///
/// `guac: false` routes the gateway to the direct SSH handler (`ssh.rs`)
/// rather than the guacd path.
fn build_handshake(params: &SshProxyParams, gateway_path: &str, agent: bool) -> Vec<u8> {
	let json = serde_json::json!({
		"target":      params.target,
		"application": "ssh",
		"port":        params.port,
		"token":       params.token,
		"guac":        false,
		"username":    params.username,
		"password":    params.password,
		"width":       params.width,
		"height":      params.height,
		"gateway":     params.gateway,
		"path":        gateway_path,
		"e2ecrypt":    false,
		"agent":       agent,
	});
	let mut bytes = json.to_string().into_bytes();
	bytes.push(b'\n');
	bytes
}
