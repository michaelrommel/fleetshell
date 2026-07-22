//! ZScaler transparent-proxy bypass.
//!
//! When `fleetshell.com` is not yet registered with the corporate IT department,
//! ZScaler may intercept outbound HTTPS connections and inject an HTML "Continue"
//! block page.  This module detects that page and automatically submits the bypass
//! form so the user does not have to click a button.
//!
//! The same bypass logic covers two transport layers used by the client:
//!
//! * **HTTP (reqwest)** — [`send_with_bypass`] wraps portal enrollment requests.
//! * **Raw TCP/TLS (tunnel)** — [`handle_gateway_block`] is called from
//!   `tunnel.rs` when the gateway response line starts with `"HTTP/"` instead
//!   of the expected `"200 CONNECTED"`.

use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt as _;

const BYPASS_URL: &str = "https://gateway.zscaler.net:443/_sm_ctn";

// ── Detection ─────────────────────────────────────────────────────────────────

/// Returns `true` if `body` looks like a ZScaler "Please Continue" block page.
pub fn is_block_page(body: &str) -> bool {
	body.contains("_sm_ctn") && body.contains("gateway.zscaler.net")
}

/// Extracts the `value` of a `<input name="<name>">` from raw HTML.
///
/// Handles both attribute orderings (`name` before `value` and vice-versa)
/// within the same `<input …>` tag.
pub fn extract_hidden(html: &str, name: &str) -> Option<String> {
	let needle    = format!("name=\"{name}\"");
	let name_pos  = html.find(needle.as_str())?;
	let tag_start = html[..name_pos].rfind("<input")?;
	let tag_end   = html[name_pos..].find('>')? + name_pos;
	let tag       = &html[tag_start..=tag_end];

	let val_start = tag.find("value=\"")? + 7; // len("value=\"")
	let val_end   = tag[val_start..].find('"')? + val_start;
	Some(tag[val_start..val_end].to_string())
}

// ── Bypass form submission ─────────────────────────────────────────────────────

/// Parse the ZScaler block-page HTML and submit the bypass form.
///
/// After this returns `Ok(())`, ZScaler marks the target domain as
/// "acknowledged" for the current user session.  Callers should then
/// retry their original request / connection.
pub async fn submit_bypass(client: &reqwest::Client, html: &str) -> Result<(), String> {
	let sm_url = extract_hidden(html, "_sm_url")
		.ok_or_else(|| "ZScaler: _sm_url not found in block page".to_string())?;
	let sm_rid = extract_hidden(html, "_sm_rid").unwrap_or_default();
	let sm_cat = extract_hidden(html, "_sm_cat").unwrap_or_default();

	log::warn!(
		"[ZScaler] block detected for {sm_url} — submitting bypass (rid={sm_rid})"
	);

	client
		.get(BYPASS_URL)
		.query(&[
			("_sm_url", sm_url.as_str()),
			("_sm_rid", sm_rid.as_str()),
			("_sm_cat", sm_cat.as_str()),
		])
		.send()
		.await
		.map_err(|e| format!("[ZScaler] bypass form submission failed: {e}"))?;

	log::info!("[ZScaler] bypass acknowledged by gateway.zscaler.net");
	Ok(())
}

// ── HTTP (reqwest) wrapper ─────────────────────────────────────────────────────

/// Build a `reqwest::Client` suitable for portal enrollment.
///
/// * Loads the OS certificate store — this ensures ZScaler's enterprise CA
///   (installed by MDM/GPO) is trusted automatically.
/// * Enables the cookie store so any ZScaler session cookie issued during the
///   bypass is retained and sent on the immediate retry.
pub fn build_portal_client() -> Result<reqwest::Client, String> {
	reqwest::Client::builder()
		.cookie_store(true)
		.build()
		.map_err(|e| format!("HTTP client error: {e}"))
}

/// Send a request, transparently handling a ZScaler block page if one is returned.
///
/// `build` is a closure that constructs the `RequestBuilder`; it is called
/// **twice** if a bypass is needed — once for the initial attempt and once to
/// retry after the bypass has been submitted.  The closure must therefore be
/// `Fn` (not `FnOnce`).
///
/// If the server returns an HTML page that is *not* a ZScaler block page, an
/// error is returned (portal API endpoints only return JSON; unexpected HTML
/// always signals a problem).
pub async fn send_with_bypass<F>(
	client: &reqwest::Client,
	build:  F,
) -> Result<reqwest::Response, String>
where
	F: Fn() -> reqwest::RequestBuilder,
{
	let resp = build()
		.send()
		.await
		.map_err(|e| format!("Request failed: {e}"))?;

	// Fast path: only HTML responses can be ZScaler block pages.
	let is_html = resp
		.headers()
		.get(reqwest::header::CONTENT_TYPE)
		.and_then(|v| v.to_str().ok())
		.map(|ct| ct.contains("text/html"))
		.unwrap_or(false);

	if !is_html {
		return Ok(resp);
	}

	let body = resp
		.text()
		.await
		.map_err(|e| format!("Failed to read response body: {e}"))?;

	if !is_block_page(&body) {
		let snip = &body[..body.len().min(400)];
		return Err(format!("Unexpected HTML from portal API: {snip}"));
	}

	// Submit the bypass; the same cookie-store client retains whatever session
	// token ZScaler issues so the retry passes through automatically.
	submit_bypass(client, &body).await?;

	// Retry the original request — ZScaler now permits the domain.
	build()
		.send()
		.await
		.map_err(|e| format!("Request failed after ZScaler bypass: {e}"))
}

// ── Raw TCP/TLS (tunnel) helpers ───────────────────────────────────────────────

/// Drain the remainder of an HTTP response from a raw async stream, given that
/// the **first line** (`"HTTP/1.1 200 OK"` etc.) has already been consumed by
/// `read_line`.
///
/// Reads header lines until the blank separator, extracts `Content-Length`,
/// then reads up to that many body bytes (capped at 512 KiB).  Returns the
/// body as a UTF-8 string (non-UTF-8 bytes are replaced with `U+FFFD`).
pub async fn drain_http_body<S>(stream: &mut S) -> Result<String, String>
where
	S: AsyncRead + Unpin,
{
	// ── Read remaining headers ─────────────────────────────────────────────
	let mut content_length: usize = 0;
	let mut cur_header = Vec::<u8>::with_capacity(128);
	let mut byte = [0u8; 1];

	loop {
		match stream.read(&mut byte).await {
			Ok(0) | Err(_) => return Ok(String::new()), // stream closed
			Ok(_) => {}
		}
		if byte[0] == b'\n' {
			// Trim trailing \r, lowercase for header matching
			let header = String::from_utf8_lossy(&cur_header)
				.trim_end_matches('\r')
				.to_lowercase();

			if header.is_empty() {
				break; // blank line → end of headers
			}
			if let Some(v) = header.strip_prefix("content-length:") {
				if let Ok(n) = v.trim().parse::<usize>() {
					content_length = n.min(512 * 1024);
				}
			}
			cur_header.clear();
		} else {
			cur_header.push(byte[0]);
		}
	}

	// ── Read body ──────────────────────────────────────────────────────────
	let limit = if content_length > 0 { content_length } else { 64 * 1024 };
	let mut body = vec![0u8; limit];
	let mut total = 0;

	while total < limit {
		match stream.read(&mut body[total..]).await {
			Ok(0) | Err(_) => break,
			Ok(n)          => total += n,
		}
	}
	body.truncate(total);

	Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Called from `tunnel.rs` when the gateway's first response line starts with
/// `"HTTP/"` — a sign that ZScaler has intercepted the raw TLS connection and
/// injected an HTTP block page instead of the gateway's protocol response.
///
/// Drains the remaining HTTP headers + body, checks for a ZScaler block page,
/// and if found submits the bypass form.  The tunnel connection is abandoned
/// afterwards; the **next** connection attempt from the browser will succeed
/// because ZScaler now permits the gateway domain for the session.
///
/// Navigates the UI to the Logging tab in all cases so the user can see what
/// happened.
pub async fn handle_gateway_block<S>(
	stream:     &mut S,
	first_line: &str,
	port:       u16,
	app:        &tauri::AppHandle,
)
where
	S: AsyncRead + Unpin,
{
	log::warn!(
		"port {port} — gateway returned HTTP instead of tunnel protocol: '{first_line}'; \
		 possible ZScaler interception — draining response"
	);

	let body = match drain_http_body(stream).await {
		Ok(b)  => b,
		Err(e) => {
			log::error!("port {port} — could not drain gateway HTTP response: {e}");
			crate::util::navigate(app, "logging");
			return;
		}
	};

	if !is_block_page(&body) {
		log::error!(
			"port {port} — unexpected HTTP from gateway (not a ZScaler block page): \
			 {}…",
			&body[..body.len().min(300)]
		);
		crate::util::navigate(app, "logging");
		return;
	}

	// Build a minimal one-shot client for the bypass submission.
	// Cookie persistence is not required here — ZScaler's session is managed
	// at the proxy/network level for TCP connections, not via HTTP cookies.
	let bypass_client = match reqwest::Client::builder().build() {
		Ok(c)  => c,
		Err(e) => {
			log::error!("port {port} — could not create bypass client: {e}");
			crate::util::navigate(app, "logging");
			return;
		}
	};

	match submit_bypass(&bypass_client, &body).await {
		Ok(()) => {
			log::warn!(
				"port {port} — ZScaler bypass submitted for gateway domain. \
				 The blocked connection has been closed. \
				 Please retry — the next connection attempt will pass through."
			);
		}
		Err(e) => {
			log::error!("port {port} — ZScaler bypass failed: {e}");
		}
	}

	crate::util::navigate(app, "logging");
}
