//! Direct SSH terminal handler — bypasses guacd entirely.
//!
//! Connects to the target SSH server using [`russh`], allocates a PTY, starts
//! a shell, and relays raw terminal bytes bidirectionally between the SSH
//! channel and the connected client stream.
//!
//! # Wire protocol (after `200 CONNECTED\n`)
//!
//! ## Client → gateway
//!
//! Every message is a **framed packet**:
//!
//! ```text
//! +----------+------------------+---------+
//! | type (1) | length (2, BE)   | payload |
//! +----------+------------------+---------+
//! ```
//!
//! | Type | Payload | Meaning |
//! |------|---------|---------|
//! | `0x00` | N bytes | keyboard data → PTY stdin |
//! | `0x01` | 4 bytes: u16 BE rows, u16 BE cols | PTY resize (SIGWINCH) |
//!
//! ## Gateway → client
//!
//! Raw bytes from the SSH channel stdout/stderr — no framing.
//! The browser pipes these directly into `xterm.js`'s `terminal.write()`.
//!
//! # Authentication
//!
//! Password auth only in this iteration.  Key-based auth can be added later.
//!
//! # Host-key verification
//!
//! All host keys are accepted (TOFU can be layered on top later).

use std::net::SocketAddr;
use std::sync::Arc;

use russh::client;
use russh::keys::PublicKey;
use russh::ChannelMsg;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tracing::{debug, info, warn};

// ── Parameters ────────────────────────────────────────────────────────────────

/// Everything needed to open an SSH session.
pub struct SshParams {
	/// Hostname or IP of the SSH server.
	pub hostname: String,
	/// SSH port (typically 22).
	pub port: u16,
	/// SSH username.
	pub username: String,
	/// Password for authentication.
	pub password: String,
	/// Initial PTY columns.
	pub cols: u32,
	/// Initial PTY rows.
	pub rows: u32,
}

// ── Host-key handler ──────────────────────────────────────────────────────────

/// Accepts all SSH host keys without verification.
///
/// The JWT validated by the caller already constrains the connection to a
/// specific target IP + port.  Host-key pinning (TOFU) can be added later.
struct AcceptAllKeys;

impl client::Handler for AcceptAllKeys {
	type Error = russh::Error;

	async fn check_server_key(
		&mut self,
		_server_public_key: &PublicKey,
	) -> Result<bool, Self::Error> {
		Ok(true)
	}
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Run a direct SSH terminal session.
///
/// Called **after** `200 CONNECTED\n` has been written to `stream`.
/// Returns when either side closes the connection.
pub async fn run<S>(stream: S, peer: SocketAddr, params: SshParams)
where
	S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
	match run_inner(stream, peer, &params).await {
		Ok(()) => info!(%peer, "SSH session ended cleanly"),
		Err(e) => warn!(%peer, "SSH session ended with error: {e}"),
	}
}

// ── Inner implementation ──────────────────────────────────────────────────────

async fn run_inner<S>(
	stream: S,
	peer: SocketAddr,
	params: &SshParams,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
	S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
	let target = format!("{}:{}", params.hostname, params.port);
	info!(%peer, %target, username = %params.username, "SSH: connecting");

	// ── 1. TCP connect + SSH handshake ────────────────────────────────────────
	let config = Arc::new(client::Config::default());
	let mut session = client::connect(config, target.as_str(), AcceptAllKeys)
		.await
		.map_err(|e| format!("SSH connect to {target} failed: {e}"))?;

	// ── 2. Password authentication ────────────────────────────────────────────
	let auth_result = session
		.authenticate_password(&params.username, &params.password)
		.await
		.map_err(|e| format!("SSH auth error for '{}' at {target}: {e}", params.username))?;

	if !auth_result.success() {
		return Err(format!(
			"SSH authentication rejected for user '{}' at {target}",
			params.username
		)
		.into());
	}
	info!(%peer, %target, "SSH: authenticated");

	// ── 3. Open session channel ───────────────────────────────────────────────
	let channel = session
		.channel_open_session()
		.await
		.map_err(|e| format!("SSH channel open failed: {e}"))?;

	// ── 4. Request PTY ────────────────────────────────────────────────────────
	// `want_reply = false`: skip the per-request success/failure reply to avoid
	// an extra round-trip.  Standard practice for interactive sessions.
	channel
		.request_pty(
			false,            // want_reply
			"xterm-256color", // sets $TERM on the remote
			params.cols,      // character cell width
			params.rows,      // character cell height
			0, 0,             // pixel dimensions — not used by most servers
			&[],              // terminal modes: empty = server defaults
		)
		.await
		.map_err(|e| format!("PTY request failed: {e}"))?;

	info!(%peer, cols = params.cols, rows = params.rows, "SSH: PTY allocated");

	// ── 5. Start interactive shell ────────────────────────────────────────────
	channel
		.request_shell(false)
		.await
		.map_err(|e| format!("shell request failed: {e}"))?;

	info!(%peer, "SSH: shell started — entering relay");

	// ── 6. Bidirectional relay ────────────────────────────────────────────────
	relay(stream, channel, peer).await;

	// ── 7. Clean disconnect ───────────────────────────────────────────────────
	session
		.disconnect(russh::Disconnect::ByApplication, "session ended", "en-US")
		.await
		.ok();

	Ok(())
}

// ── Relay loop ────────────────────────────────────────────────────────────────

/// Relay bytes between the client stream and the SSH channel until either side
/// closes.
///
/// ## Client → gateway framing
///
/// Incoming bytes are parsed as length-prefixed frames:
///
/// ```text
/// [type:u8][length:u16 BE][payload: length bytes]
/// ```
///
/// Partial headers are buffered across read calls (TCP may deliver less than 3
/// bytes at once).
///
/// ## Gateway → client
///
/// SSH channel output is written directly — no framing.
async fn relay<S>(
	stream: S,
	mut channel: russh::Channel<russh::client::Msg>,
	peer: SocketAddr,
) where
	S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
	let (mut rx, mut tx) = tokio::io::split(stream);

	// ── Frame-parser state (client → gateway direction) ───────────────────────
	// We buffer bytes until we have a complete 3-byte header, then a complete
	// payload.
	let mut hdr     = [0u8; 3]; // [type, len_hi, len_lo]
	let mut hdr_pos = 0usize;
	let mut payload: Vec<u8> = Vec::new();
	let mut pay_pos = 0usize;
	let mut ftype   = 0u8;

	let mut raw = vec![0u8; 8192]; // read scratch buffer

	loop {
		tokio::select! {
			// ── SSH channel → client ──────────────────────────────────────────
			msg = channel.wait() => {
				match msg {
					Some(ChannelMsg::Data { ref data }) => {
						debug!(%peer, bytes = data.len(), "SSH → client");
						if tx.write_all(data).await.is_err()
							|| tx.flush().await.is_err()
						{
							debug!(%peer, "client write failed (disconnected)");
							break;
						}
					}
					Some(ChannelMsg::ExtendedData { ref data, ext }) => {
						// ext = 1 is stderr; surface it so the user sees errors.
						debug!(%peer, ext, bytes = data.len(), "SSH stderr → client");
						tx.write_all(data).await.ok();
						tx.flush().await.ok();
					}
					Some(ChannelMsg::Eof) => {
						info!(%peer, "SSH: remote EOF");
						break;
					}
					Some(ChannelMsg::ExitStatus { exit_status }) => {
						info!(%peer, exit_status, "SSH: shell exited");
						// Don't break immediately — wait for the Eof/Close so
						// the client receives the final output.
					}
					Some(ChannelMsg::Close) => {
						info!(%peer, "SSH: channel closed by server");
						break;
					}
					Some(other) => {
						debug!(%peer, msg = ?other, "SSH: unhandled channel message");
					}
					None => {
						info!(%peer, "SSH: channel stream exhausted");
						break;
					}
				}
			}

			// ── Client → SSH (framed) ─────────────────────────────────────────
			result = rx.read(&mut raw) => {
				let n = match result {
					Ok(0) => { info!(%peer, "client EOF"); break; }
					Ok(n) => n,
					Err(e) => { debug!(%peer, "client read error: {e}"); break; }
				};

				// Run the frame parser over the newly arrived bytes.
				let mut cur = 0usize;
				while cur < n {
					// ── Phase 1: accumulate 3-byte header ──────────────────────
					if hdr_pos < 3 {
						let take = (3 - hdr_pos).min(n - cur);
						hdr[hdr_pos..hdr_pos + take]
							.copy_from_slice(&raw[cur..cur + take]);
						hdr_pos += take;
						cur     += take;

						if hdr_pos == 3 {
							ftype   = hdr[0];
							let len = u16::from_be_bytes([hdr[1], hdr[2]]) as usize;
							payload.resize(len, 0);
							pay_pos = 0;
						}
						continue;
					}

					// ── Phase 2: accumulate payload ────────────────────────────
					let take = (payload.len() - pay_pos).min(n - cur);
					payload[pay_pos..pay_pos + take]
						.copy_from_slice(&raw[cur..cur + take]);
					pay_pos += take;
					cur     += take;

					if pay_pos < payload.len() {
						continue; // not yet complete
					}

					// ── Dispatch complete frame ────────────────────────────────
					match ftype {
						// 0x00 — keyboard data → PTY stdin
						0x00 => {
							debug!(%peer, bytes = payload.len(), "client → SSH data");
							if let Err(e) = channel.data(payload.as_slice()).await {
								warn!(%peer, "SSH channel write failed: {e}");
								return;
							}
						}
						// 0x01 — PTY resize (4 bytes: u16 BE rows, u16 BE cols)
						0x01 if payload.len() == 4 => {
							let rows = u16::from_be_bytes([payload[0], payload[1]]) as u32;
							let cols = u16::from_be_bytes([payload[2], payload[3]]) as u32;
							info!(%peer, rows, cols, "SSH: PTY resize");
							// window_change signature: (col_width, row_height, pix_w, pix_h)
							if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
								warn!(%peer, "PTY resize failed: {e}");
							}
						}
						other => {
							warn!(%peer, frame_type = other, len = payload.len(),
								"SSH: unknown frame type — discarding");
						}
					}

					// Reset parser for the next frame.
					hdr_pos = 0;
				}
			}
		}
	}

	// Signal EOF to the remote shell so it exits cleanly.
	channel.eof().await.ok();
}
