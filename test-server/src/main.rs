//! FleetShell test device server.
//!
//! Generates a random bacteria-themed name on start (e.g. "Lollygagging Listeria").
//! The name appears in the self-signed TLS certificate CN and in the web UI.
//!
//! Ports
//! ─────
//!   8080  HTTP  — main web UI  (/ and /data)
//!   8443  HTTPS — main web UI  (/ and /data)
//!   4080  HTTP  — JSON API     (/api/data)
//!   4443  HTTPS — JSON API     (/api/data)
//!
//! Demonstrates FleetShell multi-port tunnelling: tunnel all four ports on one
//! slot, open the /data page, and watch it fetch live data from the API ports.

use std::sync::Arc;

use axum::{Json, Router, extract::State, response::Html, routing::{get, post}};
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

/// Picks a random name by reading 8 bytes from `/dev/urandom`.
/// Works correctly even when many containers are started in the same second —
/// each gets independent OS entropy.
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

/// Generates one self-signed cert that covers both `localhost`/`127.0.0.1` and
/// the container hostname.  Shared across ports 8443 and 4443.
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

// ── Shared TLS accept loop ────────────────────────────────────────────────────

/// Runs forever: accepts plain TCP connections and serves `app` over HTTP/1.1.
/// Using `http1::Builder` explicitly (instead of `axum::serve` which internally
/// uses hyper-util's auto-detect builder) avoids the HTTP/0.9 probe that
/// confuses curl and some other clients.
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

/// Runs forever: accepts TCP connections, upgrades them to TLS, then hands
/// each connection to `app` via a hyper HTTP/1.1 connection.
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
	html:      Arc<String>,
	/// Pre-rendered /data page HTML.
	data_html: Arc<String>,
}

async fn index_handler(State(s): State<MainState>) -> Html<String> {
	Html((*s.html).clone())
}

async fn data_handler(State(s): State<MainState>) -> Html<String> {
	Html((*s.data_html).clone())
}

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
		.route("/check", post(check_handler))
		.with_state(state)
}

// ── API-server state & handlers ───────────────────────────────────────────────

#[derive(Clone)]
struct ApiState {
	/// The port this instance is actually listening on — included in the response.
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
		// Permissive CORS so the browser page on a different port can fetch freely.
		.layer(CorsLayer::permissive())
		.with_state(ApiState { port })
}

// ── HTML: home page ───────────────────────────────────────────────────────────

/// Placeholders replaced at startup: `{NAME}`.
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
    nav { align-self: stretch; display: flex; justify-content: flex-end; }
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
    <nav><a href="/data">API Data Demo →</a></nav>
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

/// Placeholders replaced at startup: `{NAME}`.
///
/// The JS chooses the API port at runtime based on `location.protocol`:
///   http:  → port 4080
///   https: → port 4443
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
    nav { align-self: stretch; }
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
    /* ── message card ─────────────────────────────────────────────── */
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
    /* ── status bar ───────────────────────────────────────────────── */
    .status {
      font-size: 0.85rem; color: var(--gray); font-family: monospace;
      align-self: flex-start; min-height: 1.2em;
    }
    .status.ok   { color: var(--green); }
    .status.err  { color: var(--red);   }
    .status.spin::before { content: '⟳ '; animation: spin 1s linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* ── cert hint ────────────────────────────────────────────────── */
    .cert-hint {
      display: none; background: var(--bg); border: 1px solid var(--orange);
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
    /* ── buttons ──────────────────────────────────────────────────── */
    .btn {
      padding: 0.7rem 1.4rem; font-size: 0.95rem; font-weight: 700;
      background: var(--blue-d); color: var(--fg);
      border: none; border-radius: 8px; cursor: pointer;
      font-family: inherit; letter-spacing: 0.04em;
      transition: background 0.15s, transform 0.08s;
    }
    .btn:hover  { background: var(--blue); }
    .btn:active { transform: scale(0.97); }
    /* ── port badge ───────────────────────────────────────────────── */
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
    <nav><a href="/">← {NAME}</a></nav>

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
    // Choose the matching API port for the current scheme so there are
    // no mixed-content issues: http page → http API, https page → https API.
    const apiPort = location.protocol === 'https:' ? 4443 : 4080;
    const apiUrl  = `${location.protocol}//${location.hostname}:${apiPort}/api/data`;

    // Highlight the active badge
    document.getElementById(apiPort === 4443 ? 'badge-https' : 'badge-http')
            .classList.add('active');

    async function fetchData() {
      const msgBox  = document.getElementById('msg-box');
      const msgText = document.getElementById('msg-text');
      const statusEl = document.getElementById('status');
      const certHint = document.getElementById('cert-hint');

      // reset
      msgText.classList.remove('visible');
      msgBox.className  = 'msg-box';
      statusEl.className = 'status spin';
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

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
	tracing_subscriber::fmt::init();

	let name     = pick_name();
	let hostname = get_hostname();

	// One self-signed cert, shared between ports 8443 and 4443.
	let tls = generate_tls_acceptor(&name)?;

	// Pre-render both HTML pages once (cheap string replace at startup).
	let main_state = MainState {
		html:      Arc::new(HTML_TEMPLATE      .replace("{NAME}", &name)),
		data_html: Arc::new(DATA_HTML_TEMPLATE .replace("{NAME}", &name)),
	};

	let main_router     = build_main_router(main_state);
	let api_http_router = build_api_router(4080);
	let api_tls_router  = build_api_router(4443);

	// Bind all four ports upfront so any "address in use" error surfaces immediately.
	let l_8080 = TcpListener::bind("0.0.0.0:8080").await?;
	let l_8443 = TcpListener::bind("0.0.0.0:8443").await?;
	let l_4080 = TcpListener::bind("0.0.0.0:4080").await?;
	let l_4443 = TcpListener::bind("0.0.0.0:4443").await?;

	info!(name, hostname, "▶  main  HTTP  :8080");
	info!(name, hostname, "▶  main  HTTPS :8443");
	info!(name, hostname, "▶  api   HTTP  :4080");
	info!(name, hostname, "▶  api   HTTPS :4443");

	let t1 = tokio::spawn(serve_http(l_8080, main_router.clone()));
	let t2 = tokio::spawn(serve_tls (l_8443, tls.clone(), main_router));
	let t3 = tokio::spawn(serve_http(l_4080, api_http_router));
	let t4 = tokio::spawn(serve_tls (l_4443, tls,         api_tls_router));

	let _ = tokio::join!(t1, t2, t3, t4);
	Ok(())
}
