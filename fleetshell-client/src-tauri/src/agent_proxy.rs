//! SSH authentication-agent multiplexing (client side).
//!
//! For direct-SSH (xterm.js) sessions the browser talks to the client only for
//! PTY bytes.  When the user enables agent support, the ssh-agent protocol is
//! carried **in-band** on the same client<->gateway SSH connection during the
//! authentication phase (before any PTY bytes flow).  This avoids a second
//! connection, which is unreliable behind a load balancer when the client's
//! connections are NAT'd to different source IPs (corporate egress / Zscaler)
//! and therefore land on different gateway containers.
//!
//! # Wire framing (auth phase, both directions)
//!
//! ```text
//!   0x00  [u32 BE len]  [len bytes]     one complete ssh-agent message
//! ```
//!
//! The leading `0x00` lets us tell an agent record apart from the final
//! `200 CONNECTED\n` / `401 UNAUTHORIZED\n` status line (which starts with an
//! ASCII digit).  The gateway is the initiator: it sends an agent *request*
//! record, the client forwards it to the local agent, reads the agent's
//! *reply*, and sends it back as a record.  When the gateway is done it sends
//! the status line, ending the auth phase; the caller then relays raw PTY
//! bytes as before.
//!
//! Private keys never leave this machine; only sign requests are relayed.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Combined async-IO supertrait so a boxed agent transport (Windows named pipe
/// vs. Unix socket) can live behind one trait object.  A trait object may name
/// only one non-auto trait, so `AsyncRead + AsyncWrite` must be merged here.
pub trait AgentIo: tokio::io::AsyncRead + tokio::io::AsyncWrite {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite> AgentIo for T {}

/// Type-erased local agent transport: a Windows named pipe or a Unix socket.
pub type AgentTransport = Box<dyn AgentIo + Unpin + Send>;

/// Maximum ssh-agent message length we relay (matches russh's limit).
const MAX_AGENT_FRAME: usize = 256 * 1024;

// ── Local agent transport ────────────────────────────────────────────────────

/// Open the local SSH agent endpoint.
///
/// Windows: an OpenSSH Agent Service (or Pageant-compatible) named pipe.
/// Unix (macOS/Linux): a Unix domain socket (typically `$SSH_AUTH_SOCK`).
pub async fn open_agent(socket: &str) -> std::io::Result<AgentTransport> {
	#[cfg(windows)]
	{
		use tokio::net::windows::named_pipe::ClientOptions;
		// ERROR_PIPE_BUSY: the agent is momentarily busy; retry briefly.
		const ERROR_PIPE_BUSY: i32 = 231;
		loop {
			match ClientOptions::new().open(socket) {
				Ok(client) => return Ok(Box::new(client)),
				Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
					tokio::time::sleep(std::time::Duration::from_millis(50)).await;
				}
				Err(e) => return Err(e),
			}
		}
	}
	#[cfg(not(windows))]
	{
		let stream = tokio::net::UnixStream::connect(socket).await?;
		Ok(Box::new(stream))
	}
}

// ── Framing helpers ───────────────────────────────────────────────────────────

/// Read one complete ssh-agent message (`[u32 BE len][payload]`), returning it
/// with the length prefix intact.  `Ok(None)` on a clean EOF at a boundary.
async fn read_agent_message<R: tokio::io::AsyncRead + Unpin>(
	r: &mut R,
) -> std::io::Result<Option<Vec<u8>>> {
	let mut len_buf = [0u8; 4];
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

// ── Auth-phase relay ──────────────────────────────────────────────────────────

/// Run the in-band ssh-agent auth phase against the gateway connection.
///
/// Reads gateway records and services them from `agent`, sending replies back,
/// until the gateway sends its status line (the first non-`0x00` byte).  The
/// trimmed status line (e.g. `"200 CONNECTED"`) is returned; the caller checks
/// it and then relays raw PTY bytes.
///
/// `agent` is the already-opened local agent transport (opened before the
/// handshake so we only advertise `agent:true` when the agent is reachable).
pub async fn run_agent_auth_phase<S>(
	gw:       &mut S,
	agent:    &mut AgentTransport,
	slot_idx: usize,
) -> Result<String, String>
where
	S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
	loop {
		// Next event from the gateway: a `0x00` agent record, or a status line.
		let mut tag = [0u8; 1];
		match gw.read(&mut tag).await.map_err(|e| format!("gateway read failed: {e}"))? {
			0 => return Err("gateway closed during agent auth".to_string()),
			_ => {}
		}

		if tag[0] == 0x00 {
			// Agent request record -> forward to the local agent.
			let request = read_agent_message(gw)
				.await
				.map_err(|e| format!("bad agent request framing: {e}"))?
				.ok_or_else(|| "truncated agent request".to_string())?;
			agent.write_all(&request).await.map_err(|e| format!("agent write failed: {e}"))?;
			agent.flush().await.map_err(|e| format!("agent flush failed: {e}"))?;

			// Read the agent's reply and send it back as a record.
			let reply = read_agent_message(agent)
				.await
				.map_err(|e| format!("agent read failed: {e}"))?
				.ok_or_else(|| "local agent closed".to_string())?;
			gw.write_all(&[0x00]).await.map_err(|e| format!("gateway write failed: {e}"))?;
			gw.write_all(&reply).await.map_err(|e| format!("gateway write failed: {e}"))?;
			gw.flush().await.map_err(|e| format!("gateway flush failed: {e}"))?;
			log::debug!("ssh slot {} agent signed one request ({} B reply)", slot_idx, reply.len());
		} else {
			// Status line: first byte is its first character; read to newline.
			let mut line = vec![tag[0]];
			let mut b = [0u8; 1];
			loop {
				match gw.read(&mut b).await.map_err(|e| format!("gateway read failed: {e}"))? {
					0 => break,
					_ => {
						if b[0] == b'\n' { break; }
						line.push(b[0]);
						if line.len() >= 256 { break; }
					}
				}
			}
			return Ok(String::from_utf8_lossy(&line).trim().to_string());
		}
	}
}
