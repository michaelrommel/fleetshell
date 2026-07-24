//! FleetShell test device server.
//!
//! Generates a random bacteria-themed name on start (e.g. "Lollygagging Listeria").
//! The name appears in the self-signed TLS certificate CN and in the web UI.
//!
//! Ports
//! ─────
//!   8080  HTTP  — main web UI  (/, /data, /live, /ws)
//!   8443  HTTPS — main web UI  (/, /data, /live, /ws)
//!   4080  HTTP  — JSON API     (/api/data)
//!   4443  HTTPS — JSON API     (/api/data)
//!
//! /live demonstrates WebSocket over the terminated-HTTPS tunnel: a server-push
//! JSON stream at 1 Hz drives a scrolling bar chart and a live clock.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
	Json, Router,
	extract::{
		State,
		ws::{Message, WebSocket, WebSocketUpgrade},
	},
	response::{Html, IntoResponse},
	routing::{get, post},
};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use rcgen::CertificateParams;
use rustls::{
	ServerConfig,
	pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt as _;
use tower_http::cors::CorsLayer;
use tracing::{error, info};

// ── Name generation ───────────────────────────────────────────────────────────

const ADJECTIVES: &[&str] = &[
	"Sauntering",      "Wandering",     "Gallivanting",  "Meandering",
	"Lollygagging",    "Sashaying",     "Moseying",      "Traipsing",
	"Cavorting",       "Frolicking",    "Prancing",      "Skulking",
	"Tiptoeing",       "Slithering",    "Ambling",       "Prowling",
	"Discombobulated", "Flabbergasted", "Bewildered",    "Cantankerous",
	"Belligerent",     "Obstinate",     "Intrepid",      "Tenacious",
	"Befuddled",       "Bamboozled",    "Bedraggled",    "Beleaguered",
	"Perturbed",       "Exasperated",   "Nonplussed",    "Confounded",
];

const NOUNS: &[&str] = &[
	"Salmonella",    "Listeria",      "Shigella",       "Brucella",
	"Campylobacter", "Yersinia",      "Klebsiella",     "Helicobacter",
	"Streptococcus", "Staphylococcus","Pneumococcus",   "Meningococcus",
	"Treponema",     "Borrelia",      "Rickettsia",     "Legionella",
	"Pseudomonas",   "Acinetobacter", "Enterococcus",   "Clostridium",
	"Vibrio",        "Bacillus",      "Bordetella",     "Haemophilus",
	"Francisella",   "Pasteurella",   "Mycobacterium",  "Chlamydia",
	"Neisseria",     "Fusobacterium", "Bacteroides",    "Prevotella",
];

fn pick_name() -> String {
	use std::io::Read as _;

	let mut buf = [0u8; 8];
	if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
		let _ = f.read_exact(&mut buf);
	}
	let s  = u64::from_le_bytes(buf);
	let s2 = s.wrapping_mul(0x9e3779b97f4a7c15).rotate_right(32);

	let adj  = ADJECTIVES[s  as usize % ADJECTIVES.len()];
	let noun = NOUNS     [s2 as usize % NOUNS.len()];
	format!("{adj} {noun}")
}

// ── Hostname ──────────────────────────────────────────────────────────────────

fn get_hostname() -> String {
	std::env::var("HOSTNAME")
		.or_else(|_| std::fs::read_to_string("/etc/hostname").map(|s| s.trim().to_string()))
		.unwrap_or_else(|_| "localhost".to_string())
}

// ── TLS ───────────────────────────────────────────────────────────────────────

fn generate_tls_acceptor(server_name: &str) -> Result<TlsAcceptor, Box<dyn std::error::Error>> {
	let hostname = get_hostname();

	let mut params = CertificateParams::new(vec![
		"localhost".to_string(),
		"127.0.0.1".to_string(),
		hostname.clone(),
	])?;
	params.distinguished_name.push(rcgen::DnType::CommonName,       server_name);
	params.distinguished_name.push(rcgen::DnType::OrganizationName, server_name);

	let key_pair = rcgen::KeyPair::generate()?;
	let cert     = params.self_signed(&key_pair)?;

	let cert_der = CertificateDer::from(cert.der().to_vec());
	let key_der  = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));

	let server_cfg = ServerConfig::builder()
		.with_no_client_auth()
		.with_single_cert(vec![cert_der], key_der)?;

	info!(cn = server_name, hostname, "self-signed TLS certificate generated");
	Ok(TlsAcceptor::from(Arc::new(server_cfg)))
}

// ── Shared accept loops ───────────────────────────────────────────────────────
//
// Both functions use `serve_connection_with_upgrades` so that the HTTP/1.1
// Upgrade mechanism works — required for the WebSocket endpoint on /ws.

async fn serve_http(listener: TcpListener, app: Router) {
	loop {
		let (tcp, addr) = match listener.accept().await {
			Ok(pair) => pair,
			Err(e)   => { error!("accept: {e}"); continue; }
		};
		let svc = app.clone();
		tokio::spawn(async move {
			let io        = TokioIo::new(tcp);
			let hyper_svc = hyper::service::service_fn(move |req: hyper::Request<Incoming>| {
				let svc = svc.clone();
				async move { svc.oneshot(req.map(axum::body::Body::new)).await }
			});
			if let Err(e) = hyper::server::conn::http1::Builder::new()
				.serve_connection(io, hyper_svc)
				.with_upgrades()
				.await
			{
				let s = e.to_string();
				if !s.contains("connection reset")
					&& !s.contains("broken pipe")
					&& !s.contains("unexpected EOF")
				{
					error!(%addr, "HTTP connection: {e}");
				}
			}
		});
	}
}

async fn serve_tls(listener: TcpListener, acceptor: TlsAcceptor, app: Router) {
	loop {
		let (tcp, addr) = match listener.accept().await {
			Ok(pair) => pair,
			Err(e)   => { error!("accept: {e}"); continue; }
		};
		let acceptor = acceptor.clone();
		let svc      = app.clone();
		tokio::spawn(async move {
			let tls = match acceptor.accept(tcp).await {
				Ok(t)  => t,
				Err(e) => { error!(%addr, "TLS handshake: {e}"); return; }
			};
			let io        = TokioIo::new(tls);
			let hyper_svc = hyper::service::service_fn(move |req: hyper::Request<Incoming>| {
				let svc = svc.clone();
				async move { svc.oneshot(req.map(axum::body::Body::new)).await }
			});
			if let Err(e) = hyper::server::conn::http1::Builder::new()
				.serve_connection(io, hyper_svc)
				.with_upgrades()
				.await
			{
				let s = e.to_string();
				if !s.contains("connection reset")
					&& !s.contains("broken pipe")
					&& !s.contains("unexpected EOF")
				{
					error!(%addr, "connection: {e}");
				}
			}
		});
	}
}

// ── Main-server state & handlers ──────────────────────────────────────────────

#[derive(Clone)]
struct MainState {
	/// Pre-rendered home page HTML.
	html:       Arc<String>,
	/// Pre-rendered /data page HTML.
	data_html:  Arc<String>,
	/// Pre-rendered /live page HTML.
	live_html:  Arc<String>,
	/// Server start time — used to compute uptime for the WS stream.
	start_time: std::time::Instant,
	/// Number of currently-connected WebSocket clients.
	ws_clients: Arc<AtomicU64>,
}

async fn index_handler(State(s): State<MainState>) -> Html<String> {
	Html((*s.html).clone())
}

async fn data_handler(State(s): State<MainState>) -> Html<String> {
	Html((*s.data_html).clone())
}

async fn live_handler(State(s): State<MainState>) -> Html<String> {
	Html((*s.live_html).clone())
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

/// HTTP upgrade entry-point for `GET /ws`.
async fn ws_handler(
	ws:             WebSocketUpgrade,
	State(state):   State<MainState>,
) -> impl IntoResponse {
	ws.on_upgrade(move |socket| handle_ws(socket, state))
}

/// Drives a single WebSocket connection.
///
/// Pushes a JSON stats message every second:
/// ```json
/// { "unix_ms": 1705316245000, "uptime_secs": 42, "ws_clients": 2 }
/// ```
/// Terminates cleanly on close frame or send error.
async fn handle_ws(mut socket: WebSocket, state: MainState) {
	let n = state.ws_clients.fetch_add(1, Ordering::Relaxed) + 1;
	info!(clients = n, "WebSocket client connected");

	let mut ticker = tokio::time::interval(Duration::from_secs(1));

	loop {
		tokio::select! {
			_ = ticker.tick() => {
				let uptime_secs = state.start_time.elapsed().as_secs();
				let ws_clients  = state.ws_clients.load(Ordering::Relaxed);
				let unix_ms     = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.unwrap_or_default()
					.as_millis() as u64;

				let payload = serde_json::json!({
					"unix_ms":     unix_ms,
					"uptime_secs": uptime_secs,
					"ws_clients":  ws_clients,
				});

				if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
					break;
				}
			}
			msg = socket.recv() => {
				match msg {
					Some(Ok(Message::Close(_))) | None => break,
					_ => {} // ignore ping / pong / text from client
				}
			}
		}
	}

	let n = state.ws_clients.fetch_sub(1, Ordering::Relaxed) - 1;
	info!(clients = n, "WebSocket client disconnected");
}

// ── Service-key check ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CheckReq { servicekey: String }

#[derive(Serialize)]
struct CheckResp { ok: bool }

const SECRET_KEY: &str = "i-love-healthineers-so-much";

async fn check_handler(Json(body): Json<CheckReq>) -> Json<CheckResp> {
	Json(CheckResp { ok: body.servicekey == SECRET_KEY })
}

fn build_main_router(state: MainState) -> Router {
	Router::new()
		.route("/",      get(index_handler))
		.route("/data",  get(data_handler))
		.route("/live",  get(live_handler))
		.route("/ws",    get(ws_handler))
		.route("/check", post(check_handler))
		.with_state(state)
}

// ── API-server state & handlers ───────────────────────────────────────────────

#[derive(Clone)]
struct ApiState {
	port: u16,
}

async fn api_data_handler(State(s): State<ApiState>) -> Json<serde_json::Value> {
	Json(serde_json::json!({
		"message": format!("this is retrieved from port {}", s.port)
	}))
}

fn build_api_router(port: u16) -> Router {
	Router::new()
		.route("/api/data", get(api_data_handler))
		.layer(CorsLayer::permissive())
		.with_state(ApiState { port })
}

// ── HTML: home page ───────────────────────────────────────────────────────────

const HTML_TEMPLATE: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{NAME}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:     #282828; --bg1:    #3c3836; --bg2:    #504945; --bg3:    #665c54;
      --fg:     #ebdbb2; --fg2:    #d5c4a1; --gray:   #928374;
      --red:    #fb4934; --green:  #b8bb26; --yellow: #fabd2f;
      --blue:   #83a598; --blue-d: #458588; --aqua:   #8ec07c;
    }
    body {
      background: var(--bg); color: var(--fg);
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh; display: flex; align-items: center;
      justify-content: center; padding: 2rem;
    }
    .container {
      width: 100%; max-width: 560px;
      display: flex; flex-direction: column; align-items: center; gap: 2.5rem;
    }
    nav { align-self: stretch; display: flex; justify-content: flex-end; gap: 0.5rem; }
    nav a {
      color: var(--aqua); font-size: 0.9rem; font-weight: 600;
      text-decoration: none; letter-spacing: 0.06em;
      padding: 0.4rem 0.8rem; border: 1px solid var(--bg2);
      border-radius: 6px; transition: background 0.15s, color 0.15s;
    }
    nav a:hover { background: var(--bg1); color: var(--blue); }
    .brand { text-align: center; }
    .brand h1 {
      font-size: 2.9rem; font-weight: 700; letter-spacing: 0.03em;
      color: var(--yellow); line-height: 1.15;
      text-shadow: 0 2px 16px rgba(250,189,47,0.20);
    }
    .brand .subtitle {
      margin-top: 0.45rem; font-size: 0.82rem; color: var(--gray);
      letter-spacing: 0.12em; text-transform: uppercase;
    }
    .card {
      background: var(--bg1); border: 1px solid var(--bg2); border-radius: 12px;
      padding: 2rem 2.5rem; width: 100%;
      display: flex; flex-direction: column; gap: 1.1rem;
    }
    .field { display: flex; flex-direction: column; gap: 0.45rem; }
    label {
      font-size: 0.78rem; font-weight: 600; color: var(--fg2);
      letter-spacing: 0.10em; text-transform: uppercase;
    }
    input[type="text"] {
      width: 100%; padding: 0.85rem 1.1rem; font-size: 1.2rem;
      background: var(--bg); color: var(--fg);
      border: 2px solid var(--bg3); border-radius: 8px;
      outline: none; font-family: inherit;
      transition: border-color 0.18s, box-shadow 0.18s;
    }
    input[type="text"]::placeholder { color: var(--gray); }
    input[type="text"]:focus {
      border-color: var(--blue); box-shadow: 0 0 0 3px rgba(131,165,152,0.18);
    }
    button {
      padding: 0.85rem 1rem; font-size: 1.05rem; font-weight: 700;
      background: var(--blue-d); color: var(--fg);
      border: none; border-radius: 8px; cursor: pointer;
      letter-spacing: 0.05em; font-family: inherit;
      transition: background 0.15s, transform 0.08s;
    }
    button:hover  { background: var(--blue); }
    button:active { transform: scale(0.97); }
    .result { display: none; flex-direction: column; align-items: center; gap: 1.1rem; }
    .result.visible {
      display: flex;
      animation: pop-in 0.38s cubic-bezier(0.34,1.56,0.64,1) both;
    }
    @keyframes pop-in {
      from { opacity: 0; transform: scale(0.55); }
      to   { opacity: 1; transform: scale(1);    }
    }
    .circle {
      width: 168px; height: 168px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 36px rgba(0,0,0,0.45);
    }
    .circle.ok  { background: var(--green); }
    .circle.err { background: var(--red);   }
    .circle svg {
      width: 84px; height: 84px; stroke: #282828; stroke-width: 3;
      stroke-linecap: round; stroke-linejoin: round; fill: none;
    }
    .result-label { font-size: 1.35rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
    .result-label.ok  { color: var(--green); }
    .result-label.err { color: var(--red);   }
  </style>
</head>
<body>
  <div class="container">
    <nav>
      <a href="/data">API Data →</a>
      <a href="/live">Live WS →</a>
    </nav>
    <div class="brand">
      <h1>{NAME}</h1>
      <div class="subtitle">Test Device Portal</div>
    </div>
    <div class="card">
      <div class="field">
        <label for="sk">Servicekey</label>
        <input type="text" id="sk" placeholder="Enter service key…"
               autocomplete="off" spellcheck="false">
      </div>
      <button onclick="checkKey()">Submit</button>
    </div>
    <div class="result" id="result">
      <div class="circle" id="circle">
        <svg id="icon" viewBox="0 0 24 24"></svg>
      </div>
      <div class="result-label" id="msg"></div>
    </div>
  </div>
  <script>
    async function checkKey() {
      const val = document.getElementById('sk').value.trim();
      let data;
      try {
        const res = await fetch('/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ servicekey: val }),
        });
        data = await res.json();
      } catch (e) { console.error('fetch failed', e); return; }

      const resultEl = document.getElementById('result');
      const circleEl = document.getElementById('circle');
      const iconEl   = document.getElementById('icon');
      const msgEl    = document.getElementById('msg');
      resultEl.classList.remove('visible');
      void resultEl.offsetWidth;
      if (data.ok) {
        circleEl.className = 'circle ok';
        iconEl.innerHTML   = '<polyline points="20 6 9 17 4 12"/>';
        msgEl.className    = 'result-label ok';
        msgEl.textContent  = 'Access Granted';
      } else {
        circleEl.className = 'circle err';
        iconEl.innerHTML   = '<line x1="18" y1="6" x2="6" y2="18"/>'
                           + '<line x1="6"  y1="6" x2="18" y2="18"/>';
        msgEl.className    = 'result-label err';
        msgEl.textContent  = 'Access Denied';
      }
      resultEl.classList.add('visible');
    }
    document.getElementById('sk').addEventListener('keydown', e => {
      if (e.key === 'Enter') checkKey();
    });
  </script>
</body>
</html>
"##;

// ── HTML: /data page ──────────────────────────────────────────────────────────

const DATA_HTML_TEMPLATE: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Data — {NAME}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:     #282828; --bg1:    #3c3836; --bg2:    #504945; --bg3:    #665c54;
      --fg:     #ebdbb2; --fg2:    #d5c4a1; --gray:   #928374;
      --red:    #fb4934; --green:  #b8bb26; --yellow: #fabd2f;
      --blue:   #83a598; --blue-d: #458588; --aqua:   #8ec07c; --orange: #fe8019;
    }
    body {
      background: var(--bg); color: var(--fg);
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh; display: flex; align-items: center;
      justify-content: center; padding: 2rem;
    }
    .container {
      width: 100%; max-width: 620px;
      display: flex; flex-direction: column; align-items: center; gap: 2.5rem;
    }
    nav { align-self: stretch; display: flex; gap: 0.5rem; }
    nav a {
      color: var(--aqua); font-size: 0.9rem; font-weight: 600;
      text-decoration: none; letter-spacing: 0.06em;
      padding: 0.4rem 0.8rem; border: 1px solid var(--bg2);
      border-radius: 6px; transition: background 0.15s, color 0.15s;
    }
    nav a:hover { background: var(--bg1); color: var(--blue); }
    .brand { text-align: center; }
    .brand h1 {
      font-size: 2.4rem; font-weight: 700; color: var(--yellow);
      letter-spacing: 0.03em; line-height: 1.15;
    }
    .brand .subtitle {
      margin-top: 0.4rem; font-size: 0.82rem; color: var(--gray);
      letter-spacing: 0.12em; text-transform: uppercase;
    }
    .msg-card {
      background: var(--bg1); border: 1px solid var(--bg2);
      border-radius: 12px; padding: 2.5rem 2.5rem;
      width: 100%; display: flex; flex-direction: column;
      align-items: center; gap: 1.4rem;
    }
    .msg-label {
      font-size: 0.78rem; font-weight: 600; color: var(--fg2);
      letter-spacing: 0.12em; text-transform: uppercase; align-self: flex-start;
    }
    .msg-box {
      width: 100%; background: var(--bg); border: 2px solid var(--bg3);
      border-radius: 8px; padding: 1.8rem 1.6rem;
      min-height: 7rem;
      display: flex; align-items: center; justify-content: center;
      transition: border-color 0.25s;
    }
    .msg-box.ok   { border-color: var(--aqua); }
    .msg-box.err  { border-color: var(--red);  }
    .msg-text {
      font-size: 1.45rem; font-weight: 600; color: var(--aqua);
      text-align: center; line-height: 1.4;
      opacity: 0; transform: translateY(8px);
      transition: opacity 0.3s, transform 0.3s;
    }
    .msg-text.visible { opacity: 1; transform: translateY(0); }
    .status {
      font-size: 0.85rem; color: var(--gray); font-family: monospace;
      align-self: flex-start; min-height: 1.2em;
    }
    .status.ok   { color: var(--green); }
    .status.err  { color: var(--red);   }
    .cert-hint {
      background: var(--bg); border: 1px solid var(--orange);
      border-radius: 8px; padding: 1rem 1.2rem;
      width: 100%; display: none; flex-direction: column; gap: 0.8rem;
    }
    .cert-hint p { font-size: 0.88rem; color: var(--fg2); line-height: 1.5; }
    .cert-hint a {
      color: var(--orange); font-size: 0.88rem; font-weight: 600;
      word-break: break-all;
    }
    .cert-hint .hint-row {
      display: flex; gap: 0.8rem; align-items: center; flex-wrap: wrap;
    }
    .btn {
      padding: 0.7rem 1.4rem; font-size: 0.95rem; font-weight: 700;
      background: var(--blue-d); color: var(--fg);
      border: none; border-radius: 8px; cursor: pointer;
      font-family: inherit; letter-spacing: 0.04em;
      transition: background 0.15s, transform 0.08s;
    }
    .btn:hover  { background: var(--blue); }
    .btn:active { transform: scale(0.97); }
    .port-row {
      display: flex; gap: 0.6rem; flex-wrap: wrap; justify-content: center;
    }
    .port-badge {
      font-size: 0.8rem; font-weight: 600; letter-spacing: 0.06em;
      padding: 0.25rem 0.7rem; border-radius: 4px; font-family: monospace;
      background: var(--bg2); color: var(--fg2);
    }
    .port-badge.active { background: var(--blue-d); color: var(--fg); }
  </style>
</head>
<body>
  <div class="container">
    <nav>
      <a href="/">← {NAME}</a>
      <a href="/live">Live WS →</a>
    </nav>

    <div class="brand">
      <h1>API Data Demo</h1>
      <div class="subtitle">Multi-port tunnel demonstration</div>
    </div>

    <div class="msg-card">
      <div class="msg-label">Response from API port</div>

      <div class="port-row">
        <span class="port-badge" id="badge-http">HTTP :4080</span>
        <span class="port-badge" id="badge-https">HTTPS :4443</span>
      </div>

      <div class="msg-box" id="msg-box">
        <div class="msg-text" id="msg-text">—</div>
      </div>

      <div class="status" id="status">Initialising…</div>

      <div class="cert-hint" id="cert-hint">
        <p>The fetch failed — likely because the API's self-signed certificate is
           not yet trusted in your browser. Open the API endpoint in a new tab,
           accept the certificate warning, then come back and retry.</p>
        <div class="hint-row">
          <a id="cert-link" href="#" target="_blank" rel="noopener">Open API endpoint ↗</a>
          <button class="btn" onclick="fetchData()">Retry</button>
        </div>
      </div>

      <button class="btn" onclick="fetchData()">↺ Refresh</button>
    </div>
  </div>
  <script>
    const apiPort = location.protocol === 'https:' ? 4443 : 4080;
    const apiUrl  = `${location.protocol}//${location.hostname}:${apiPort}/api/data`;

    document.getElementById(apiPort === 4443 ? 'badge-https' : 'badge-http')
            .classList.add('active');

    async function fetchData() {
      const msgBox   = document.getElementById('msg-box');
      const msgText  = document.getElementById('msg-text');
      const statusEl = document.getElementById('status');
      const certHint = document.getElementById('cert-hint');

      msgText.classList.remove('visible');
      msgBox.className  = 'msg-box';
      statusEl.className = 'status';
      statusEl.textContent = `Fetching from ${apiUrl} …`;
      certHint.style.display = 'none';

      try {
        const res  = await fetch(apiUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        msgText.textContent = data.message;
        msgText.classList.add('visible');
        msgBox.classList.add('ok');
        statusEl.className   = 'status ok';
        statusEl.textContent = `✓  ${apiUrl}`;

      } catch (err) {
        msgText.textContent = '(no response)';
        msgBox.classList.add('err');
        statusEl.className   = 'status err';
        statusEl.textContent = `✗  ${err.message || 'fetch failed'} — ${apiUrl}`;
        document.getElementById('cert-link').href = apiUrl;
        certHint.style.display = 'flex';
      }
    }

    fetchData();
  </script>
</body>
</html>
"##;

// ── HTML: /live page ──────────────────────────────────────────────────────────
//
// Connects to GET /ws via WebSocket (ws:// or wss:// based on current protocol).
// Server pushes { unix_ms, uptime_secs, ws_clients } at 1 Hz.
// The page renders:
//   - Live server clock  (UTC)
//   - Uptime / WS clients / received-message counters
//   - Scrolling bar chart (40 bars, sine-wave phase, shifts left on each tick)

const LIVE_HTML_TEMPLATE: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live WS — {NAME}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:     #282828; --bg1:    #3c3836; --bg2:    #504945; --bg3:    #665c54;
      --fg:     #ebdbb2; --fg2:    #d5c4a1; --gray:   #928374;
      --red:    #fb4934; --bright-red: #fb4934;
      --green:  #b8bb26; --bright-green: #b8bb26;
      --yellow: #fabd2f;
      --blue:   #83a598; --blue-d: #458588; --aqua:   #8ec07c;
    }
    body {
      background: var(--bg); color: var(--fg);
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh; display: flex; align-items: center;
      justify-content: center; padding: 2rem;
    }
    .container {
      width: 100%; max-width: 600px;
      display: flex; flex-direction: column; align-items: center; gap: 2rem;
    }
    nav { align-self: stretch; display: flex; gap: 0.5rem; }
    nav a {
      color: var(--aqua); font-size: 0.9rem; font-weight: 600;
      text-decoration: none; letter-spacing: 0.06em;
      padding: 0.4rem 0.8rem; border: 1px solid var(--bg2);
      border-radius: 6px; transition: background 0.15s, color 0.15s;
    }
    nav a:hover { background: var(--bg1); color: var(--blue); }

    /* ── Status pill ──────────────────────────────────────────────────────── */
    .status-pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 18px; border-radius: 20px;
      font-size: 0.82rem; font-weight: 700;
      letter-spacing: 0.12em; text-transform: uppercase;
      border: 1px solid var(--bg3); background: var(--bg1); color: var(--gray);
      transition: border-color 0.3s, color 0.3s;
    }
    .status-pill.connected    { border-color: var(--green); color: var(--bright-green); }
    .status-pill.disconnected { border-color: var(--red);   color: var(--bright-red);   }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: currentColor; flex-shrink: 0;
    }
    .status-pill.connected .dot {
      animation: pulse-dot 1.5s ease-in-out infinite;
    }
    @keyframes pulse-dot {
      0%, 100% { box-shadow: 0 0 0 0   rgba(184,187,38, 0.6); }
      50%       { box-shadow: 0 0 0 5px rgba(184,187,38, 0);   }
    }

    /* ── Clock ────────────────────────────────────────────────────────────── */
    .clock-block { text-align: center; }
    .clock {
      font-size: 3.6rem; font-weight: 700; font-family: monospace;
      color: var(--yellow); letter-spacing: 0.04em; line-height: 1.1;
    }
    .date-line {
      margin-top: 0.4rem; font-size: 0.88rem;
      color: var(--gray); letter-spacing: 0.06em;
    }

    /* ── Stats row ────────────────────────────────────────────────────────── */
    .stats-row {
      display: grid; grid-template-columns: 1fr 1fr 1fr;
      gap: 14px; width: 100%;
    }
    .stat-card {
      background: var(--bg1); border: 1px solid var(--bg2);
      border-radius: 10px; padding: 1.1rem 0.8rem;
      text-align: center; display: flex; flex-direction: column; gap: 0.5rem;
    }
    .stat-label {
      font-size: 0.7rem; font-weight: 600; color: var(--fg2);
      text-transform: uppercase; letter-spacing: 0.1em;
    }
    .stat-value {
      font-size: 1.75rem; font-weight: 700;
      font-family: monospace; color: var(--aqua);
    }

    /* ── Bar chart ────────────────────────────────────────────────────────── */
    .pulse-card {
      background: var(--bg1); border: 1px solid var(--bg2);
      border-radius: 10px; padding: 1.2rem 1.4rem;
      width: 100%; display: flex; flex-direction: column; gap: 0.9rem;
    }
    .pulse-label {
      font-size: 0.7rem; font-weight: 600; color: var(--fg2);
      text-transform: uppercase; letter-spacing: 0.1em;
    }
    .bars {
      display: flex; align-items: flex-end; gap: 3px; height: 80px;
    }
    .bar {
      flex: 1; min-width: 0; min-height: 3px; border-radius: 2px 2px 0 0;
      background: linear-gradient(to top, var(--blue-d), var(--aqua));
      transition: height 0.45s ease;
    }
  </style>
</head>
<body>
  <div class="container">
    <nav>
      <a href="/">← {NAME}</a>
      <a href="/data">API Data →</a>
    </nav>

    <div class="status-pill" id="pill">
      <span class="dot"></span>
      <span id="pill-text">Connecting…</span>
    </div>

    <div class="clock-block">
      <div class="clock"    id="clock">--:--:-- UTC</div>
      <div class="date-line" id="date">---</div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value" id="uptime">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">WS Clients</div>
        <div class="stat-value" id="ws-clients">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Messages</div>
        <div class="stat-value" id="msg-count">0</div>
      </div>
    </div>

    <div class="pulse-card">
      <div class="pulse-label">Server Pulse — 1 message per second via WebSocket</div>
      <div class="bars" id="bars"></div>
    </div>
  </div>

  <script>
    const NBARS = 40;
    let msgCount  = 0;
    let ws        = null;

    // ── Bar chart ────────────────────────────────────────────────────────────
    // Compute bar height (px) for a given counter value.
    // Sine wave over the message count creates a smooth scrolling wave.
    function barHeight(n) {
      return Math.round(4 + 72 * (0.5 + 0.5 * Math.sin(n * 0.4)));
    }

    // Seed initial bar values using phase offsets so the chart looks full
    // right from the start.
    const barEls = [];
    const barsDiv = document.getElementById('bars');
    for (let i = 0; i < NBARS; i++) {
      const el = document.createElement('div');
      el.className = 'bar';
      el.style.height = barHeight(i) + 'px';
      barsDiv.appendChild(el);
      barEls.push(el);
    }

    function pushBar(tick) {
      // Shift left: copy next bar's height down, set new rightmost height.
      for (let i = 0; i < NBARS - 1; i++) {
        barEls[i].style.height = barEls[i + 1].style.height;
      }
      barEls[NBARS - 1].style.height = barHeight(tick) + 'px';
    }

    // ── Status pill ──────────────────────────────────────────────────────────
    function setStatus(state) {
      const pill = document.getElementById('pill');
      const txt  = document.getElementById('pill-text');
      pill.className = 'status-pill ' + state;
      if      (state === 'connected')    txt.textContent = 'Live';
      else if (state === 'disconnected') txt.textContent = 'Disconnected — reconnecting…';
      else                               txt.textContent = 'Connecting…';
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function fmtUptime(s) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      if (h > 0) return h + 'h ' + m + 'm ' + r + 's';
      if (m > 0) return m + 'm ' + r + 's';
      return r + 's';
    }

    // ── WebSocket ────────────────────────────────────────────────────────────
    function connect() {
      setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');

      ws.onopen = () => setStatus('connected');

      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        msgCount++;

        // Clock
        const d = new Date(data.unix_ms);
        document.getElementById('clock').textContent =
          d.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC';
        document.getElementById('date').textContent =
          d.toLocaleDateString('en-GB', {
            timeZone: 'UTC', weekday: 'long',
            day: 'numeric', month: 'short', year: 'numeric'
          });

        // Stats
        document.getElementById('uptime').textContent    = fmtUptime(data.uptime_secs);
        document.getElementById('ws-clients').textContent = data.ws_clients;
        document.getElementById('msg-count').textContent  = msgCount;

        // Bars
        pushBar(msgCount);
      };

      ws.onclose = () => {
        setStatus('disconnected');
        setTimeout(connect, 2000);
      };
    }

    connect();
  </script>
</body>
</html>
"##;

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
	tracing_subscriber::fmt::init();

	let name     = pick_name();
	let hostname = get_hostname();

	let tls = generate_tls_acceptor(&name)?;

	let main_state = MainState {
		html:       Arc::new(HTML_TEMPLATE      .replace("{NAME}", &name)),
		data_html:  Arc::new(DATA_HTML_TEMPLATE .replace("{NAME}", &name)),
		live_html:  Arc::new(LIVE_HTML_TEMPLATE .replace("{NAME}", &name)),
		start_time: std::time::Instant::now(),
		ws_clients: Arc::new(AtomicU64::new(0)),
	};

	let main_router     = build_main_router(main_state);
	let api_http_router = build_api_router(4080);
	let api_tls_router  = build_api_router(4443);

	let l_8080 = TcpListener::bind("0.0.0.0:8080").await?;
	let l_8443 = TcpListener::bind("0.0.0.0:8443").await?;
	let l_4080 = TcpListener::bind("0.0.0.0:4080").await?;
	let l_4443 = TcpListener::bind("0.0.0.0:4443").await?;

	info!(name, hostname, "▶  main  HTTP  :8080  (/, /data, /live, /ws)");
	info!(name, hostname, "▶  main  HTTPS :8443  (/, /data, /live, /ws)");
	info!(name, hostname, "▶  api   HTTP  :4080  (/api/data)");
	info!(name, hostname, "▶  api   HTTPS :4443  (/api/data)");

	let t1 = tokio::spawn(serve_http(l_8080, main_router.clone()));
	let t2 = tokio::spawn(serve_tls (l_8443, tls.clone(), main_router));
	let t3 = tokio::spawn(serve_http(l_4080, api_http_router));
	let t4 = tokio::spawn(serve_tls (l_4443, tls,         api_tls_router));

	let _ = tokio::join!(t1, t2, t3, t4);
	Ok(())
}
