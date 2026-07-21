/// HTTP/1.1-aware transform proxy.
///
/// When `transform = true` in the handshake payload the gateway switches from
/// a raw byte relay (`copy_bidirectional`) to a full HTTP/1.1 request-response
/// cycle that lets a [`TransformHook`] inspect and mutate every message.
///
/// # Flow (per request)
///
/// ```text
/// client ──HTTP req──► read_header_block + read_body
///                      ↓ hook.on_request
/// upstream ◄──────────── write request
/// upstream ──HTTP resp─► read_header_block + read_body
///                         ↓ hook.on_response
/// client ◄─────────────── write response
/// ```
///
/// The loop continues until either side signals `Connection: close` or
/// the connection is terminated.
///
/// # HTTPS upstream
///
/// For `application = "https"` the gateway opens its own TLS client session to
/// the upstream via [`connect_tls_upstream`].  When
/// `GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS=true` (the default, appropriate
/// for medical devices with self-signed certificates) the certificate chain is
/// not verified; TLS handshake signatures are still checked cryptographically.
use std::sync::Arc;

use rustls::client::danger::{
	HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::io::{
	AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream as ClientTlsStream;
use tracing::{debug, info, warn};

use crate::handler::HandshakePayload;

// ── Size limits ───────────────────────────────────────────────────────────────

/// Maximum bytes buffered while reading the header block (prevents slow-loris
/// and OOM attacks).
const MAX_HEADER_BUF: usize = 64 * 1_024;       // 64 KiB

/// Maximum body buffered in memory.  Requests or responses larger than this
/// are rejected with an I/O error.
const MAX_BODY_BYTES: usize = 16 * 1_024 * 1_024; // 16 MiB

// ── Transform hook ────────────────────────────────────────────────────────────

/// Callback interface for inspecting and mutating HTTP messages.
///
/// Both methods receive a fully-parsed [`HttpMessage`] in memory and may
/// freely edit headers or replace the body.  The default implementations are
/// no-ops, so implementors only override what they need.
///
/// Hooks are shared across all concurrent connections via `Arc<dyn
/// TransformHook>`, so they **must** be `Send + Sync`.  Per-connection state
/// should be kept inside a `tokio::sync::Mutex`.
pub trait TransformHook: Send + Sync {
	/// Called after the client's HTTP request has been parsed, before it is
	/// forwarded to the upstream server.
	fn on_request(&self, _msg: &mut HttpMessage) {}

	/// Called after the upstream's HTTP response has been parsed, before it
	/// is forwarded back to the client.
	fn on_response(&self, _msg: &mut HttpMessage) {}
}

/// No-op hook.  The gateway passes requests and responses through unmodified,
/// acting as a plain HTTP/HTTPS reverse proxy.
pub struct NoopHook;
impl TransformHook for NoopHook {}

// ── HTTP message ──────────────────────────────────────────────────────────────

/// A fully-buffered HTTP/1.1 request or response, ready for inspection and
/// mutation.
pub struct HttpMessage {
	/// Request line (`"GET /path HTTP/1.1"`) or status line
	/// (`"HTTP/1.1 200 OK"`).  Modified by the hook if method, path, or
	/// status code needs to change.
	pub first_line: String,

	/// Header fields in wire order.  Names are preserved exactly as received.
	pub headers: Vec<(String, String)>,

	/// Message body.  May be empty for `HEAD`, `204 No Content`, `304 Not
	/// Modified`, etc.
	pub body: Vec<u8>,
}

impl HttpMessage {
	/// Find the first header whose name matches `name` (case-insensitive).
	pub fn header(&self, name: &str) -> Option<&str> {
		let lc = name.to_ascii_lowercase();
		self.headers
			.iter()
			.find(|(k, _)| k.to_ascii_lowercase() == lc)
			.map(|(_, v)| v.as_str())
	}

	/// Replace the first matching header, or append a new one if absent.
	#[allow(dead_code)] // Public API for TransformHook implementors.
	pub fn set_header(&mut self, name: &str, value: impl Into<String>) {
		let lc = name.to_ascii_lowercase();
		if let Some(pos) = self
			.headers
			.iter()
			.position(|(k, _)| k.to_ascii_lowercase() == lc)
		{
			self.headers[pos].1 = value.into();
		} else {
			self.headers.push((name.to_string(), value.into()));
		}
	}

	/// Remove all headers matching `name` (case-insensitive).
	#[allow(dead_code)] // Public API for TransformHook implementors.
	pub fn remove_header(&mut self, name: &str) {
		let lc = name.to_ascii_lowercase();
		self.headers.retain(|(k, _)| k.to_ascii_lowercase() != lc);
	}

	/// Serialise back to on-wire bytes.
	///
	/// **Note**: `Content-Length` is **not** updated automatically.  If the
	/// hook modifies `body`, it must also call
	/// `set_header("content-length", new_len.to_string())`.
	fn to_bytes(&self) -> Vec<u8> {
		let cap = self.first_line.len()
			+ 2
			+ self
				.headers
				.iter()
				.map(|(k, v)| k.len() + v.len() + 4)
				.sum::<usize>()
			+ 2
			+ self.body.len();

		let mut out = Vec::with_capacity(cap);
		out.extend_from_slice(self.first_line.as_bytes());
		out.extend_from_slice(b"\r\n");
		for (k, v) in &self.headers {
			out.extend_from_slice(k.as_bytes());
			out.extend_from_slice(b": ");
			out.extend_from_slice(v.as_bytes());
			out.extend_from_slice(b"\r\n");
		}
		out.extend_from_slice(b"\r\n");
		out.extend_from_slice(&self.body);
		out
	}
}

// ── TLS upstream connector ────────────────────────────────────────────────────

/// Wrap a plain TCP stream in a TLS client session targeting `hostname`.
///
/// When `accept_invalid` is `true` the upstream certificate chain is **not**
/// verified.  The TLS handshake signatures are still checked so the session
/// is not completely unauthenticated — only the trust anchor check is skipped.
/// This is the appropriate setting for medical devices that carry self-signed
/// certificates.
pub async fn connect_tls_upstream(
	tcp: TcpStream,
	hostname: &str,
	accept_invalid: bool,
) -> Result<ClientTlsStream<TcpStream>, Box<dyn std::error::Error + Send + Sync>> {
	let config = if accept_invalid {
		warn!(
			hostname,
			"connecting to upstream with certificate verification \
			 DISABLED (GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS=true)"
		);
		ClientConfig::builder()
			.dangerous()
			.with_custom_certificate_verifier(SkipServerVerification::new())
			.with_no_client_auth()
	} else {
		// Use an empty root store.  For connections to publicly-trusted CAs,
		// add the `webpki-roots` crate and populate the store from
		// `webpki_roots::TLS_SERVER_ROOTS`.
		let root_store = rustls::RootCertStore::empty();
		ClientConfig::builder()
			.with_root_certificates(root_store)
			.with_no_client_auth()
	};

	let connector = TlsConnector::from(Arc::new(config));
	let server_name = ServerName::try_from(hostname.to_string())
		.map_err(|e| format!("invalid upstream hostname '{hostname}': {e}"))?;
	let tls_stream = connector.connect(server_name, tcp).await?;
	Ok(tls_stream)
}

// ── Dangerous: skip certificate chain validation ──────────────────────────────

/// A custom [`ServerCertVerifier`] that skips the certificate chain trust
/// check while still cryptographically verifying the TLS handshake signatures.
///
/// # Safety
///
/// This bypasses X.509 chain validation.  Use only when connecting to
/// endpoints whose self-signed certificate cannot be added to a trust store
/// (e.g. medical device firmware).  The connection is still encrypted; only
/// the identity of the remote endpoint is unverified.
#[derive(Debug)]
struct SkipServerVerification(Arc<rustls::crypto::CryptoProvider>);

impl SkipServerVerification {
	fn new() -> Arc<Self> {
		Arc::new(Self(Arc::new(rustls::crypto::ring::default_provider())))
	}
}

impl ServerCertVerifier for SkipServerVerification {
	fn verify_server_cert(
		&self,
		_end_entity: &CertificateDer<'_>,
		_intermediates: &[CertificateDer<'_>],
		_server_name: &ServerName<'_>,
		_ocsp_response: &[u8],
		_now: UnixTime,
	) -> Result<ServerCertVerified, rustls::Error> {
		// Skip chain validation — accept any certificate.
		Ok(ServerCertVerified::assertion())
	}

	fn verify_tls12_signature(
		&self,
		message: &[u8],
		cert: &CertificateDer<'_>,
		dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, rustls::Error> {
		// Delegate to ring for actual cryptographic signature verification.
		rustls::crypto::verify_tls12_signature(
			message,
			cert,
			dss,
			&self.0.signature_verification_algorithms,
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
			&self.0.signature_verification_algorithms,
		)
	}

	fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
		self.0.signature_verification_algorithms.supported_schemes()
	}
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Run the HTTP/1.1 transform proxy loop for a single tunnel connection.
///
/// Reads full HTTP/1.1 request messages from `client`, calls
/// `hook.on_request`, forwards to `target`, reads responses, calls
/// `hook.on_response`, and writes back to `client`.  Loops until either
/// side signals `Connection: close` or the connection drops.
///
/// Both `client` and `target` are consumed; the caller must not use them
/// after this function returns.
pub async fn run<C, T>(
	client: C,
	target: T,
	payload: &HandshakePayload,
	hook: Arc<dyn TransformHook>,
) where
	C: AsyncRead + AsyncWrite + Unpin + Send,
	T: AsyncRead + AsyncWrite + Unpin + Send,
{
	// Split both streams so we can hold independent mutable read and write
	// references without fighting the borrow checker.
	let (client_r, mut client_w) = tokio::io::split(client);
	let (target_r, mut target_w) = tokio::io::split(target);
	let mut client_r = BufReader::new(client_r);
	let mut target_r = BufReader::new(target_r);

	let label = format!("{}:{}", payload.target, payload.port);

	loop {
		// ── 1. Read request headers from client ───────────────────────────
		let req_buf = match read_header_block(&mut client_r, MAX_HEADER_BUF).await {
			Ok(Some(b)) => b,
			Ok(None) => {
				debug!(target = %label, "client closed connection cleanly");
				break;
			}
			Err(e) => {
				warn!(target = %label, "error reading request headers: {e}");
				break;
			}
		};

		// ── 2. Parse request line + headers ───────────────────────────────
		let (mut request, req_head_end) = match parse_request(&req_buf) {
			Ok(v) => v,
			Err(e) => {
				warn!(target = %label, "malformed HTTP request: {e}");
				break;
			}
		};

		// ── 3. Read request body ──────────────────────────────────────────
		request.body = match read_body(&mut client_r, &request, &req_buf[req_head_end..]).await {
			Ok(b) => b,
			Err(e) => {
				warn!(target = %label, "error reading request body: {e}");
				break;
			}
		};

		let keep_alive_client = is_keep_alive(&request);

		// ── 4. Apply request hook ─────────────────────────────────────────
		hook.on_request(&mut request);

		// ── 5. Forward (possibly modified) request to upstream ────────────
		let req_bytes = request.to_bytes();
		if target_w.write_all(&req_bytes).await.is_err()
			|| target_w.flush().await.is_err()
		{
			warn!(target = %label, "failed to write request to upstream");
			break;
		}

		// ── 6. Read response headers from upstream ────────────────────────
		let resp_buf = match read_header_block(&mut target_r, MAX_HEADER_BUF).await {
			Ok(Some(b)) => b,
			Ok(None) => {
				debug!(target = %label, "upstream closed connection");
				break;
			}
			Err(e) => {
				warn!(target = %label, "error reading response headers: {e}");
				break;
			}
		};

		// ── 7. Parse response line + headers ──────────────────────────────
		let (mut response, resp_head_end) = match parse_response(&resp_buf) {
			Ok(v) => v,
			Err(e) => {
				warn!(target = %label, "malformed HTTP response: {e}");
				break;
			}
		};

		// ── 8. Read response body ─────────────────────────────────────────
		response.body =
			match read_body(&mut target_r, &response, &resp_buf[resp_head_end..]).await {
				Ok(b) => b,
				Err(e) => {
					warn!(target = %label, "error reading response body: {e}");
					break;
				}
			};

		let keep_alive_upstream = is_keep_alive(&response);

		info!(
			target   = %label,
			status   = %response.first_line,
			body_len = response.body.len(),
			"proxied"
		);

		// ── 9. Apply response hook ────────────────────────────────────────
		hook.on_response(&mut response);

		// ── 10. Write (possibly modified) response back to client ─────────
		let resp_bytes = response.to_bytes();
		if client_w.write_all(&resp_bytes).await.is_err()
			|| client_w.flush().await.is_err()
		{
			warn!(target = %label, "failed to write response to client");
			break;
		}

		// ── 11. Keep-alive decision ───────────────────────────────────────
		if !keep_alive_client || !keep_alive_upstream {
			debug!(target = %label, "closing (Connection: close)");
			break;
		}
	}
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Read bytes from `reader` until the `\r\n\r\n` header terminator, up to
/// `max_bytes`.
///
/// Returns:
/// - `Ok(Some(buf))` — `buf` contains the header block including `\r\n\r\n`.
/// - `Ok(None)`      — clean EOF before any data (connection closed between
///                     requests, which is normal with `Connection: close`).
/// - `Err(_)`        — I/O error, partial headers at EOF, or size limit exceeded.
async fn read_header_block<R: AsyncRead + Unpin>(
	reader: &mut BufReader<R>,
	max_bytes: usize,
) -> std::io::Result<Option<Vec<u8>>> {
	let mut buf = Vec::with_capacity(512);
	let mut byte = [0u8; 1];

	loop {
		match reader.read(&mut byte).await? {
			0 => {
				return if buf.is_empty() {
					Ok(None)
				} else {
					Err(std::io::Error::new(
						std::io::ErrorKind::UnexpectedEof,
						"connection closed inside HTTP headers",
					))
				};
			}
			_ => {
				buf.push(byte[0]);
				if buf.len() > max_bytes {
					return Err(std::io::Error::new(
						std::io::ErrorKind::InvalidData,
						"HTTP headers exceed size limit",
					));
				}
				if buf.ends_with(b"\r\n\r\n") {
					return Ok(Some(buf));
				}
			}
		}
	}
}

/// Parse HTTP/1.x request line + headers using `httparse`.
///
/// Returns `(message, header_section_len)` where `header_section_len` is the
/// number of bytes consumed by the header block (including `\r\n\r\n`).  Any
/// bytes in `buf` beyond that offset are body bytes that arrived early.
fn parse_request(buf: &[u8]) -> Result<(HttpMessage, usize), String> {
	let mut headers = [httparse::EMPTY_HEADER; 128];
	let mut req = httparse::Request::new(&mut headers);
	match req.parse(buf) {
		Ok(httparse::Status::Complete(n)) => {
			let first_line = format!(
				"{} {} HTTP/1.{}",
				req.method.unwrap_or("GET"),
				req.path.unwrap_or("/"),
				req.version.unwrap_or(1),
			);
			let headers = req
				.headers
				.iter()
				.map(|h| (h.name.to_string(), String::from_utf8_lossy(h.value).into_owned()))
				.collect();
			Ok((HttpMessage { first_line, headers, body: Vec::new() }, n))
		}
		Ok(httparse::Status::Partial) => Err("incomplete HTTP request headers".into()),
		Err(e) => Err(format!("httparse request error: {e}")),
	}
}

/// Parse HTTP/1.x status line + headers using `httparse`.
///
/// Returns `(message, header_section_len)`.
fn parse_response(buf: &[u8]) -> Result<(HttpMessage, usize), String> {
	let mut headers = [httparse::EMPTY_HEADER; 128];
	let mut resp = httparse::Response::new(&mut headers);
	match resp.parse(buf) {
		Ok(httparse::Status::Complete(n)) => {
			let first_line = format!(
				"HTTP/1.{} {} {}",
				resp.version.unwrap_or(1),
				resp.code.unwrap_or(0),
				resp.reason.unwrap_or(""),
			);
			let headers = resp
				.headers
				.iter()
				.map(|h| (h.name.to_string(), String::from_utf8_lossy(h.value).into_owned()))
				.collect();
			Ok((HttpMessage { first_line, headers, body: Vec::new() }, n))
		}
		Ok(httparse::Status::Partial) => Err("incomplete HTTP response headers".into()),
		Err(e) => Err(format!("httparse response error: {e}")),
	}
}

/// Read the message body, guided by `Transfer-Encoding` / `Content-Length`.
///
/// `leftover` contains any bytes from the header buffer that follow the
/// `\r\n\r\n` separator.  With the byte-by-byte `read_header_block` reader
/// these will always be empty, but the parameter is retained for correctness
/// in case the implementation changes.
async fn read_body<R: AsyncRead + Unpin>(
	reader: &mut BufReader<R>,
	msg: &HttpMessage,
	leftover: &[u8],
) -> std::io::Result<Vec<u8>> {
	// Transfer-Encoding: chunked takes precedence over Content-Length.
	if msg
		.header("transfer-encoding")
		.map(|v| v.to_ascii_lowercase().contains("chunked"))
		.unwrap_or(false)
	{
		return read_chunked(reader, leftover).await;
	}

	// Content-Length: read exactly that many bytes.
	if let Some(cl) = msg.header("content-length") {
		let len: usize = cl.trim().parse().map_err(|_| {
			std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid Content-Length value")
		})?;
		if len == 0 {
			return Ok(Vec::new());
		}
		if len > MAX_BODY_BYTES {
			return Err(std::io::Error::new(
				std::io::ErrorKind::InvalidData,
				"body exceeds maximum allowed size",
			));
		}
		let mut body = Vec::with_capacity(len);
		body.extend_from_slice(leftover);
		let already = body.len();
		if already < len {
			body.resize(len, 0);
			reader.read_exact(&mut body[already..]).await?;
		}
		return Ok(body);
	}

	// No framing hints — return any leftover bytes (normally empty).
	Ok(leftover.to_vec())
}

/// Read a `Transfer-Encoding: chunked` body until the terminal `0\r\n\r\n`.
async fn read_chunked<R: AsyncRead + Unpin>(
	reader: &mut BufReader<R>,
	leftover: &[u8],
) -> std::io::Result<Vec<u8>> {
	if !leftover.is_empty() {
		warn!(
			"unexpected {} leftover byte(s) before chunked body",
			leftover.len()
		);
	}

	let mut body = Vec::new();
	let mut size_line = String::new();

	loop {
		size_line.clear();
		let n = reader.read_line(&mut size_line).await?;
		if n == 0 {
			return Err(std::io::Error::new(
				std::io::ErrorKind::UnexpectedEof,
				"EOF inside chunked body",
			));
		}
		// Chunk size is hexadecimal; optional chunk-extensions follow ';'.
		let hex = size_line.trim().split(';').next().unwrap_or("").trim();
		let chunk_size = usize::from_str_radix(hex, 16).map_err(|_| {
			std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid chunk size")
		})?;
		if chunk_size == 0 {
			// Terminal chunk — consume the trailing CRLF.
			let mut trailer = [0u8; 2];
			reader.read_exact(&mut trailer).await?;
			break;
		}
		if body.len() + chunk_size > MAX_BODY_BYTES {
			return Err(std::io::Error::new(
				std::io::ErrorKind::InvalidData,
				"chunked body exceeds maximum allowed size",
			));
		}
		let offset = body.len();
		body.resize(offset + chunk_size, 0);
		reader.read_exact(&mut body[offset..]).await?;
		// Each chunk data block is followed by CRLF.
		let mut crlf = [0u8; 2];
		reader.read_exact(&mut crlf).await?;
	}

	Ok(body)
}

/// Returns `true` if the connection should be kept alive after this message.
///
/// Rules:
/// - `Connection: close`      → false (explicit close)
/// - `Connection: keep-alive` → true  (explicit keep-alive)
/// - HTTP/1.1 default         → true  (keep-alive by default)
/// - HTTP/1.0 default         → false (close by default)
fn is_keep_alive(msg: &HttpMessage) -> bool {
	match msg
		.header("connection")
		.map(|v| v.to_ascii_lowercase())
		.as_deref()
	{
		Some(v) if v.contains("close") => false,
		Some(v) if v.contains("keep-alive") => true,
		_ => msg.first_line.contains("HTTP/1.1"),
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_simple_request() {
		let raw = b"GET /index.html HTTP/1.1\r\nHost: example.com\r\n\r\n";
		let (msg, n) = parse_request(raw).unwrap();
		assert_eq!(msg.first_line, "GET /index.html HTTP/1.1");
		assert_eq!(n, raw.len());
		assert_eq!(msg.header("host"), Some("example.com"));
	}

	#[test]
	fn parse_simple_response() {
		let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
		let (msg, n) = parse_response(raw).unwrap();
		assert_eq!(msg.first_line, "HTTP/1.1 200 OK");
		assert_eq!(n, raw.len());
		assert_eq!(msg.header("content-length"), Some("0"));
	}

	#[test]
	fn set_and_remove_header() {
		let raw = b"GET / HTTP/1.1\r\nX-Foo: old\r\n\r\n";
		let (mut msg, _) = parse_request(raw).unwrap();
		msg.set_header("x-foo", "new");
		assert_eq!(msg.header("X-Foo"), Some("new"));
		msg.remove_header("X-FOO");
		assert_eq!(msg.header("x-foo"), None);
	}

	#[test]
	fn keep_alive_http11_default() {
		let raw = b"HTTP/1.1 200 OK\r\n\r\n";
		let (msg, _) = parse_response(raw).unwrap();
		assert!(is_keep_alive(&msg));
	}

	#[test]
	fn keep_alive_connection_close() {
		let raw = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n";
		let (msg, _) = parse_response(raw).unwrap();
		assert!(!is_keep_alive(&msg));
	}

	#[test]
	fn to_bytes_roundtrip() {
		let raw = b"GET /path HTTP/1.1\r\nHost: x\r\n\r\n";
		let (msg, _) = parse_request(raw).unwrap();
		assert_eq!(msg.to_bytes(), raw.to_vec());
	}
}
