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
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{Algorithm, HashAlg, PublicKey};
use russh::{cipher, kex, mac, ChannelMsg, Preferred, Pty};
use std::borrow::Cow;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tracing::{debug, info, warn};

/// Maximum length of one ssh-agent protocol message we will relay (matches
/// russh's `MAX_AGENT_FRAME_LEN`).  Guards against a corrupt length prefix
/// forcing a huge allocation.
const MAX_AGENT_FRAME: usize = 256 * 1024;

/// Explicit PTY terminal modes (termios) requested from the target, mirroring
/// what an OpenSSH client derived from a real terminal would send.
///
/// Passing an empty mode list leaves the target's line discipline undefined:
/// many non-OpenSSH servers (Cisco IOS, Dropbear, embedded stacks) then leave
/// the tty in a state where the remote line editor never engages, so cursor-key
/// escape sequences (`\x1b[A` etc.) are echoed literally as `^[[A` instead of
/// driving history / cursor movement.  Sending a sane, complete set fixes that.
///
/// `ICANON`/`ECHO` are enabled here as the *initial* cooked-mode defaults; an
/// interactive shell's line editor (bash readline, etc.) flips the tty into raw
/// mode itself as needed.  Speeds are the conventional 38400 baud placeholders.
const TERMINAL_MODES: &[(Pty, u32)] = &[
	(Pty::VINTR, 3),      // ^C
	(Pty::VQUIT, 28),     // ^\
	(Pty::VERASE, 127),   // DEL
	(Pty::VKILL, 21),     // ^U
	(Pty::VEOF, 4),       // ^D
	(Pty::VSTART, 17),    // ^Q
	(Pty::VSTOP, 19),     // ^S
	(Pty::VSUSP, 26),     // ^Z
	(Pty::VREPRINT, 18),  // ^R
	(Pty::VWERASE, 23),   // ^W
	(Pty::VLNEXT, 22),    // ^V
	(Pty::ISIG, 1),
	(Pty::ICANON, 1),
	(Pty::ECHO, 1),
	(Pty::ECHOE, 1),
	(Pty::ECHOK, 1),
	(Pty::ECHOCTL, 1),
	(Pty::ECHOKE, 1),
	(Pty::IEXTEN, 1),
	(Pty::ICRNL, 1),      // CR -> NL on input (Enter works as expected)
	(Pty::IXON, 1),
	(Pty::IMAXBEL, 1),
	(Pty::IUTF8, 1),
	(Pty::OPOST, 1),
	(Pty::ONLCR, 1),      // NL -> CRNL on output
	(Pty::TTY_OP_ISPEED, 38400),
	(Pty::TTY_OP_OSPEED, 38400),
];

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
	/// When `true`, offer legacy key-exchange, cipher and MAC algorithms in
	/// addition to the modern defaults, so old/insecure field devices can
	/// negotiate.  Strong algorithms remain first in the preference list; the
	/// weak set is only reached when the device supports nothing better.
	pub compat: bool,
}

// ── Algorithm negotiation ─────────────────────────────────────────────────────

/// Build the russh algorithm preference list.
///
/// In strict mode this is russh's modern default.  In compat mode the legacy
/// algorithms that old devices (e.g. ancient Cisco IOS) require are moved to
/// the *front* of each preference list so they are actually offered even when
/// the peer's own list is short or it stops at the first mismatch.  A capable
/// device still negotiates strong crypto because the modern defaults follow
/// right after; a weak-only device now finds a match at the head of the list.
///
/// Legacy heads:
/// - KEX:     `diffie-hellman-group-exchange-sha1`, `diffie-hellman-group14-sha1`
/// - host key: `ssh-rsa` (RSA/SHA-1) -- forced ahead of `rsa-sha2-*` because old
///   Cisco IOS advertises `rsa-sha2-256/512` in its KEXINIT but then signs the
///   exchange hash with plain `ssh-rsa` (SHA-1), which makes russh reject the
///   signature (`WrongServerSig`) when it verifies with SHA-2.  Negotiating
///   `ssh-rsa` up front makes the hash match.
/// - ciphers: `aes256-ctr`, `aes256-cbc`
/// - MACs:    `hmac-sha2-512`, `hmac-sha2-256`
fn preferred_algorithms(compat: bool) -> Preferred {
	let base = Preferred::DEFAULT;
	if !compat {
		return base;
	}

	// Prepend the legacy-friendly algorithms, then the modern defaults, then
	// the remaining weak fallbacks russh compiles in.  `dedup_front` keeps the
	// first occurrence so an algorithm listed both up front and in the base
	// list appears only once, at its preferred (front) position.
	fn dedup_front<T: PartialEq + Clone>(front: &[T], base: &[T], tail: &[T]) -> Vec<T> {
		let mut out: Vec<T> = Vec::new();
		for item in front.iter().chain(base.iter()).chain(tail.iter()) {
			if !out.contains(item) {
				out.push(item.clone());
			}
		}
		out
	}

	let kexes = dedup_front(
		&[kex::DH_GEX_SHA1, kex::DH_G14_SHA1],
		&base.kex,
		&[kex::DH_G1_SHA1],
	);

	// Force ssh-rsa (SHA-1) ahead of rsa-sha2-* for the exchange-hash signature.
	let keys = dedup_front(
		&[Algorithm::Rsa { hash: None }],
		&base.key,
		&[
			Algorithm::Rsa { hash: Some(HashAlg::Sha256) },
			Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
		],
	);

	let ciphers = dedup_front(
		&[cipher::AES_256_CTR, cipher::AES_256_CBC],
		&base.cipher,
		&[cipher::AES_192_CBC, cipher::AES_128_CBC, cipher::TRIPLE_DES_CBC],
	);

	let macs = dedup_front(
		&[mac::HMAC_SHA512, mac::HMAC_SHA256],
		&base.mac,
		&[mac::HMAC_SHA1_ETM, mac::HMAC_SHA1],
	);

	Preferred {
		kex:     Cow::Owned(kexes),
		key:     Cow::Owned(keys),
		cipher:  Cow::Owned(ciphers),
		mac:     Cow::Owned(macs),
		..base
	}
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

// ── Agent authentication (in-band multiplex) ───────────────────────────────
//
// The ssh-agent protocol is carried in-band on the client<->gateway SSH
// connection during the authentication phase (no PTY bytes flow yet).  Each
// direction frames a complete agent message as:
//
//     0x00  [u32 BE len]  [len bytes]     (len-prefixed body = one agent message)
//
// The leading `0x00` lets the client tell an agent record apart from the final
// `200 CONNECTED\n` status line (which starts with the ASCII digit '2').
//
// The gateway runs russh's `AgentClient` against an in-memory duplex; two small
// relay loops translate between that duplex and the framed client connection,
// running concurrently with the authentication future.

/// Read one complete ssh-agent message (`[u32 BE len][payload]`) and return it
/// with the length prefix intact, ready to hand to an `AgentClient` / agent.
///
/// Returns `Ok(None)` on a clean EOF at a message boundary.
async fn read_agent_message<R: AsyncRead + Unpin>(
	r: &mut R,
) -> std::io::Result<Option<Vec<u8>>> {
	let mut len_buf = [0u8; 4];
	// Read the first length byte on its own so a clean EOF is not an error.
	match r.read(&mut len_buf[..1]).await? {
		0 => return Ok(None),
		_ => {}
	}
	r.read_exact(&mut len_buf[1..]).await?;
	let len = u32::from_be_bytes(len_buf) as usize;
	if len > MAX_AGENT_FRAME {
		return Err(std::io::Error::new(
			std::io::ErrorKind::InvalidData,
			"ssh-agent frame exceeds maximum length",
		));
	}
	let mut full = vec![0u8; 4 + len];
	full[..4].copy_from_slice(&len_buf);
	r.read_exact(&mut full[4..]).await?;
	Ok(Some(full))
}

/// Relay agent *requests*: read complete agent messages the `AgentClient`
/// produced (from the duplex) and write each to the client, tagged `0x00`.
async fn relay_agent_requests<Rd, Wr>(pr: &mut Rd, cw: &mut Wr) -> std::io::Result<()>
where
	Rd: AsyncRead + Unpin,
	Wr: AsyncWrite + Unpin,
{
	loop {
		match read_agent_message(pr).await? {
			Some(msg) => {
				cw.write_all(&[0x00]).await?;
				cw.write_all(&msg).await?;
				cw.flush().await?;
			}
			None => return Ok(()), // AgentClient dropped its end
		}
	}
}

/// Relay agent *replies*: read `0x00`-tagged records from the client and write
/// the embedded agent message to the duplex for the `AgentClient` to consume.
async fn relay_agent_replies<Rd, Wr>(cr: &mut Rd, pw: &mut Wr) -> std::io::Result<()>
where
	Rd: AsyncRead + Unpin,
	Wr: AsyncWrite + Unpin,
{
	loop {
		let mut tag = [0u8; 1];
		match cr.read(&mut tag).await? {
			0 => return Ok(()), // client closed
			_ => {}
		}
		if tag[0] != 0x00 {
			return Err(std::io::Error::new(
				std::io::ErrorKind::InvalidData,
				"unexpected frame tag during ssh-agent phase",
			));
		}
		match read_agent_message(cr).await? {
			Some(msg) => {
				pw.write_all(&msg).await?;
				pw.flush().await?;
			}
			None => return Err(std::io::Error::new(
				std::io::ErrorKind::UnexpectedEof,
				"truncated ssh-agent record",
			)),
		}
	}
}

/// Drive agent-based authentication with the ssh-agent protocol multiplexed
/// over the client connection halves (`cr`/`cw`).
///
/// Returns `Ok(true)` when the target accepts an agent key, `Ok(false)` if the
/// agent holds no accepted key (or the connection closed), and `Err` on a
/// russh-level failure.  The caller falls back to password auth on anything
/// other than `Ok(true)`.
async fn agent_auth_phase<R, W>(
	session:  &mut client::Handle<AcceptAllKeys>,
	username: &str,
	compat:   bool,
	cr:       &mut R,
	cw:       &mut W,
	peer:     SocketAddr,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>
where
	R: AsyncRead + Unpin + Send,
	W: AsyncWrite + Unpin + Send,
{
	// In-memory duplex: `AgentClient` speaks raw agent protocol on `agent_io`;
	// the two relay loops translate between `pump_io` and the framed client
	// connection.
	let (agent_io, pump_io) = tokio::io::duplex(MAX_AGENT_FRAME + 16);
	let (mut pr, mut pw)    = tokio::io::split(pump_io);
	let mut agent           = AgentClient::connect(agent_io);

	let auth = try_agent_auth(session, username, &mut agent, compat, peer);
	let req  = relay_agent_requests(&mut pr, cw);
	let rep  = relay_agent_replies(cr, &mut pw);
	tokio::pin!(auth, req, rep);

	loop {
		tokio::select! {
			r = &mut auth => return r,
			// A relay loop finishing means the client connection closed before
			// authentication completed — treat as "no agent key".
			r = &mut req  => { r?; return Ok(false); }
			r = &mut rep  => { r?; return Ok(false); }
		}
	}
}

/// Offer every key held by the agent for public-key authentication.
///
/// Returns `Ok(true)` as soon as the target accepts one identity, `Ok(false)`
/// if the agent holds no key the target accepts, or `Err` on an agent/transport
/// failure (the caller then falls back to password auth).
async fn try_agent_auth(
	session:  &mut client::Handle<AcceptAllKeys>,
	username: &str,
	agent:    &mut AgentClient<tokio::io::DuplexStream>,
	compat:   bool,
	peer:     SocketAddr,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
	let identities = agent.request_identities().await?;
	info!(%peer, count = identities.len(), "SSH: agent advertised identities");

	for id in identities {
		// v1: public-key identities only; OpenSSH certificate identities skipped.
		let pubkey = match id {
			AgentIdentity::PublicKey { key, comment } => {
				debug!(%peer, %comment, alg = ?key.algorithm(), "SSH: trying agent key");
				key
			}
			AgentIdentity::Certificate { comment, .. } => {
				debug!(%peer, %comment, "SSH: skipping agent certificate identity");
				continue;
			}
		};

		// RSA keys: legacy devices (compat) sign with ssh-rsa (SHA-1); modern
		// servers expect rsa-sha2-256.  Non-RSA keys ignore hash_alg.
		let hash_alg = match pubkey.algorithm() {
			Algorithm::Rsa { .. } if compat => None,
			Algorithm::Rsa { .. }           => Some(HashAlg::Sha256),
			_                               => None,
		};

		match session
			.authenticate_publickey_with(username, pubkey, hash_alg, agent)
			.await
		{
			Ok(res) if res.success() => return Ok(true),
			Ok(_)                    => continue, // key rejected, try the next
			Err(e)                   => return Err(Box::new(e)),
		}
	}

	Ok(false)
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Run a direct SSH terminal session.
///
/// When `agent_mode` is `false`, `200 CONNECTED\n` has already been written to
/// `stream` by the caller and authentication uses the password only.
///
/// When `agent_mode` is `true`, the caller has **not** sent the status line:
/// the ssh-agent protocol is multiplexed in-band on `stream` during the
/// authentication phase, and this function writes `200 CONNECTED\n` (on
/// success) or `401 UNAUTHORIZED\n` (on failure) once authentication resolves.
pub async fn run<S>(
	stream:     S,
	peer:       SocketAddr,
	params:     SshParams,
	agent_mode: bool,
)
where
	S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
	match run_inner(stream, peer, &params, agent_mode).await {
		Ok(()) => info!(%peer, "SSH session ended cleanly"),
		Err(e) => warn!(%peer, "SSH session ended with error: {e}"),
	}
}

// ── Inner implementation ──────────────────────────────────────────────────────

async fn run_inner<S>(
	stream:     S,
	peer:       SocketAddr,
	params:     &SshParams,
	agent_mode: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
	S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
	let target = format!("{}:{}", params.hostname, params.port);
	info!(%peer, %target, username = %params.username, "SSH: connecting");

	// ── 1. TCP connect + SSH handshake ────────────────────────────────────────
	let config = Arc::new(client::Config {
		preferred: preferred_algorithms(params.compat),
		..client::Config::default()
	});
	if params.compat {
		info!(%peer, %target, "SSH: legacy/compat algorithms enabled");
	}
	let mut session = client::connect(config, target.as_str(), AcceptAllKeys)
		.await
		.map_err(|e| format!("SSH connect to {target} failed: {e}"))?;

	// The client stream is split for the auth phase (agent mode multiplexes the
	// ssh-agent protocol over the read/write halves) and reunited for the PTY
	// relay afterwards.
	let (mut cr, mut cw) = tokio::io::split(stream);

	// ── 2. Authentication ─────────────────────────────────────────────────────
	// Order: SSH agent (public key, when forwarded) first, password fallback.
	// The agent holds the private keys on the user's machine; the gateway only
	// relays sign requests, so no key material ever reaches the gateway.
	let mut authenticated = false;

	if agent_mode {
		match agent_auth_phase(&mut session, &params.username, params.compat, &mut cr, &mut cw, peer).await {
			Ok(true)  => {
				info!(%peer, %target, "SSH: authenticated via agent");
				authenticated = true;
			}
			Ok(false) => info!(%peer, %target,
				"SSH: agent offered no accepted key — falling back to password"),
			Err(e)    => warn!(%peer, %target,
				"SSH: agent auth error ({e}) — falling back to password"),
		}
	}

	if !authenticated {
		let auth_result = session
			.authenticate_password(&params.username, &params.password)
			.await
			.map_err(|e| format!("SSH auth error for '{}' at {target}: {e}", params.username))?;

		if !auth_result.success() {
			// In agent mode the client is still waiting for a status line; tell
			// it authentication failed so it can surface a clean error.
			if agent_mode {
				cw.write_all(b"401 UNAUTHORIZED\n").await.ok();
				cw.flush().await.ok();
			}
			return Err(format!(
				"SSH authentication rejected for user '{}' at {target}",
				params.username
			)
			.into());
		}
		info!(%peer, %target, "SSH: authenticated via password");
	}

	// In agent mode the status line is owed now that authentication succeeded;
	// the non-agent path already sent it before this function was called.
	if agent_mode {
		cw.write_all(b"200 CONNECTED\n").await
			.map_err(|e| format!("failed to send status line: {e}"))?;
		cw.flush().await
			.map_err(|e| format!("failed to flush status line: {e}"))?;
	}

	// Reunite the halves for the PTY relay.
	let stream = cr.unsplit(cw);

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
			0, 0,             // pixel dimensions - not used by most servers
			TERMINAL_MODES,   // explicit termios so line editing / arrow keys work
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
