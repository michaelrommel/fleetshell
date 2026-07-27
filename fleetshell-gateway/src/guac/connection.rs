//! guacd connection and opening handshake.
//!
//! Connects to a running guacd daemon and performs the opening handshake
//! described in the Guacamole protocol specification:
//!
//! ```text
//! client → select  <protocol>
//! guacd  ← args    <param-name> …
//! client → size    <width> <height> <dpi>
//! client → audio   <mime-type> …
//! client → video
//! client → image   <mime-type> …
//! client → connect <value-for-each-param-in-args-order>
//! guacd  ← ready   <connection-id>
//! ```
//!
//! After `ready` the stream carries Guacamole instructions bidirectionally
//! for the lifetime of the session.  The returned [`GuacdSession`] hands the
//! caller a plain [`tokio::net::TcpStream`] positioned at that point;
//! the WebSocket bridge layer is responsible for splitting and buffering it.
//!
//! Reference: <https://guacamole.apache.org/doc/gug/guacamole-protocol.html#opening-connections>

use std::collections::HashMap;

use tokio::net::TcpStream;
use tracing::{debug, info};

use super::protocol::{Instruction, read_instruction, write_instruction};

// ── Connection parameters ─────────────────────────────────────────────────────

/// Parameters for an RDP session.
#[derive(Debug, Clone)]
pub struct RdpParams {
	/// Hostname or IP address of the Windows / RDP target.
	pub hostname: String,
	/// RDP port.  Default: 3389.
	pub port:     u16,
	/// Windows username.
	pub username: String,
	/// Password (optional — RDP may fall back to prompt-based auth).
	pub password: Option<String>,
	/// Windows domain (leave `None` for local accounts).
	pub domain:   Option<String>,
	/// Security protocol: `"rdp"`, `"nla"`, `"tls"`, `"any"`.
	/// `None` → guacd default (`"any"` = negotiate).
	pub security:    Option<String>,
	/// Skip server certificate verification.  Appropriate for embedded
	/// targets (medical devices, etc.) that carry self-signed certificates.
	pub ignore_cert: bool,
	/// Enable guacd drive sharing.  When `true`, guacd mounts `drive_path`
	/// as a virtual Windows drive inside the RDP session.
	pub enable_drive: bool,
	/// Display name of the virtual drive as it appears in Windows Explorer.
	/// Defaults to `"FleetShell"`.
	pub drive_name: String,
	/// Absolute path on the gateway host that backs the virtual drive.
	/// Must be writable by the guacd process.  Ignored when `enable_drive`
	/// is `false`.
	pub drive_path: String,
	/// Requested screen width in pixels.
	pub width:  u32,
	/// Requested screen height in pixels.
	pub height: u32,
	/// Dots per inch (96 is typical for standard displays).
	pub dpi: u32,
}

impl Default for RdpParams {
	fn default() -> Self {
		Self {
			hostname:    String::new(),
			port:        3389,
			username:    String::new(),
			password:    None,
			domain:      None,
			security:    None,
			ignore_cert: true,
			enable_drive: false,
			drive_name:   "FleetShell".into(),
			drive_path:   String::new(),
			width:       1280,
			height:      800,
			dpi:         96,
		}
	}
}

/// Parameters for a VNC session.
#[derive(Debug, Clone)]
pub struct VncParams {
	/// Hostname or IP address of the VNC server.
	pub hostname: String,
	/// VNC port.  Default: 5900.
	pub port:     u16,
	/// Username for ARD / NLA authentication (macOS Screen Sharing, etc.).
	/// Leave empty for servers that use password-only (classic VNC).
	pub username: String,
	/// VNC password (optional for unauthenticated servers).
	pub password: Option<String>,
	/// Requested screen width in pixels.
	pub width:  u32,
	/// Requested screen height in pixels.
	pub height: u32,
	/// Dots per inch.
	pub dpi: u32,
}

impl Default for VncParams {
	fn default() -> Self {
		Self {
			hostname: String::new(),
			port:     5900,
			username: String::new(),
			password: None,
			width:    1280,
			height:   800,
			dpi:      96,
		}
	}
}

/// Parameters for an SSH session.
///
/// guacd renders a full terminal emulator on the Guacamole canvas.
/// Width, height, and DPI are converted to a character-cell grid internally.
#[derive(Debug, Clone)]
pub struct SshParams {
	/// Hostname or IP address of the SSH server.
	pub hostname: String,
	/// SSH port.  Default: 22.
	pub port:     u16,
	/// SSH username.
	pub username: String,
	/// Password (optional — leave `None` to rely on key-based auth if
	/// configured on the server, or to trigger an interactive prompt).
	pub password: Option<String>,
	/// Terminal canvas width in pixels.
	pub width:  u32,
	/// Terminal canvas height in pixels.
	pub height: u32,
	/// Dots per inch (affects character cell sizing).
	pub dpi: u32,
}

impl Default for SshParams {
	fn default() -> Self {
		Self {
			hostname: String::new(),
			port:     22,
			username: String::new(),
			password: None,
			width:    1280,
			height:   800,
			dpi:      96,
		}
	}
}

/// Union of supported Guacamole connection types.
#[derive(Debug, Clone)]
pub enum ConnectionParams {
	Rdp(RdpParams),
	Vnc(VncParams),
	Ssh(SshParams),
}

impl ConnectionParams {
	/// The Guacamole protocol name sent in the `select` instruction.
	pub fn protocol_name(&self) -> &'static str {
		match self {
			Self::Rdp(_) => "rdp",
			Self::Vnc(_) => "vnc",
			Self::Ssh(_) => "ssh",
		}
	}

	fn dimensions(&self) -> (u32, u32, u32) {
		match self {
			Self::Rdp(p) => (p.width, p.height, p.dpi),
			Self::Vnc(p) => (p.width, p.height, p.dpi),
			Self::Ssh(p) => (p.width, p.height, p.dpi),
		}
	}

	/// Build a `HashMap` of Guacamole parameter name → value.
	///
	/// guacd sends the list of parameter names it expects (in its `args`
	/// instruction) and we must supply a value for each, in that same order,
	/// in the `connect` instruction.  Names not present in this map get an
	/// empty string — guacd's convention for "use the built-in default".
	fn to_value_map(&self) -> HashMap<&'static str, String> {
		let mut m: HashMap<&'static str, String> = HashMap::new();
		match self {
			Self::Rdp(p) => {
				m.insert("hostname",    p.hostname.clone());
				m.insert("port",        p.port.to_string());
				m.insert("username",    p.username.clone());
				m.insert("password",    p.password.clone().unwrap_or_default());
				m.insert("domain",      p.domain.clone().unwrap_or_default());
				m.insert("security",    p.security.clone().unwrap_or_else(|| "any".into()));
				m.insert("ignore-cert", bool_str(p.ignore_cert));
				m.insert("enable-drive",      bool_str(p.enable_drive));
				m.insert("drive-name",        p.drive_name.clone());
				m.insert("drive-path",        p.drive_path.clone());
				// Let guacd create sub-directories under drive-path automatically.
				m.insert("drive-create-path", bool_str(p.enable_drive));
				m.insert("width",       p.width.to_string());
				m.insert("height",      p.height.to_string());
				m.insert("dpi",         p.dpi.to_string());
			}
			Self::Vnc(p) => {
				m.insert("hostname", p.hostname.clone());
				m.insert("port",     p.port.to_string());
				m.insert("username", p.username.clone());
				m.insert("password", p.password.clone().unwrap_or_default());
				m.insert("width",    p.width.to_string());
				m.insert("height",   p.height.to_string());
				m.insert("dpi",      p.dpi.to_string());
			}
			Self::Ssh(p) => {
				m.insert("hostname", p.hostname.clone());
				m.insert("port",     p.port.to_string());
				m.insert("username", p.username.clone());
				m.insert("password", p.password.clone().unwrap_or_default());
				// guacd uses pixel dimensions to compute character-cell grid.
				m.insert("width",    p.width.to_string());
				m.insert("height",   p.height.to_string());
				m.insert("dpi",      p.dpi.to_string());
			}
		}
		m
	}
}

fn bool_str(b: bool) -> String {
	if b { "true" } else { "false" }.into()
}

// ── Session result ────────────────────────────────────────────────────────────

/// A connected guacd session that has completed the opening handshake.
///
/// `.stream` is positioned immediately after the `ready` instruction; all
/// further bytes are Guacamole instructions flowing in both directions.
/// The caller (WebSocket bridge) should split and buffer the stream for
/// concurrent reading and writing.
pub struct GuacdSession {
	/// Opaque connection ID assigned by guacd (e.g. `$260d01da-…`).
	/// Preserved here for logging and future session-sharing / join use.
	pub connection_id: String,
	/// The post-handshake TCP stream ready for bidirectional instruction
	/// exchange.
	pub stream: TcpStream,
}

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum GuacdError {
	#[error("TCP connection to guacd failed: {0}")]
	Connect(#[from] std::io::Error),

	#[error("guacd protocol error: {0}")]
	Protocol(String),

	#[error("unexpected instruction from guacd: expected '{expected}', got '{got}'")]
	UnexpectedInstruction { expected: &'static str, got: String },
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Connect to guacd at `addr` and perform the full opening handshake for the
/// given protocol.
///
/// On success returns a [`GuacdSession`] whose stream is ready for
/// bidirectional Guacamole instruction streaming.
pub async fn connect(addr: &str, params: ConnectionParams) -> Result<GuacdSession, GuacdError> {
	let protocol = params.protocol_name();
	info!(%addr, %protocol, "opening guacd session");

	let mut stream = TcpStream::connect(addr).await?;

	// ── 1. select <protocol> ────────────────────────────────────────────────
	let select = Instruction::new("select", vec![protocol.into()]);
	debug!(tx = %select, "→ guacd");
	write_instruction(&mut stream, &select).await?;

	// ── 2. Receive args ──────────────────────────────────────────────────────
	// guacd responds with the ordered list of parameter names it expects.
	let args_inst = read_instruction(&mut stream).await?;
	debug!(rx = %args_inst, "← guacd");
	if args_inst.opcode != "args" {
		return Err(GuacdError::UnexpectedInstruction {
			expected: "args",
			got:      args_inst.opcode,
		});
	}
	let param_names = args_inst.args;
	debug!(count = param_names.len(), "guacd listed expected parameters");

	// ── 3. Client capability instructions ───────────────────────────────────
	let (width, height, dpi) = params.dimensions();

	for instr in capability_instructions(width, height, dpi) {
		debug!(tx = %instr, "→ guacd");
		write_instruction(&mut stream, &instr).await?;
	}

	// ── 4. connect — one value per param, in the order guacd listed them ────
	let value_map = params.to_value_map();
	let values: Vec<String> = param_names
		.iter()
		.map(|name| value_map.get(name.as_str()).cloned().unwrap_or_default())
		.collect();
	let connect = Instruction::new("connect", values);
	debug!(param_count = connect.args.len(), "→ guacd connect");
	write_instruction(&mut stream, &connect).await?;

	// ── 5. Receive ready ─────────────────────────────────────────────────────
	let ready_inst = read_instruction(&mut stream).await?;
	debug!(rx = %ready_inst, "← guacd");
	if ready_inst.opcode != "ready" {
		return Err(GuacdError::UnexpectedInstruction {
			expected: "ready",
			got:      ready_inst.opcode,
		});
	}
	let connection_id = ready_inst
		.args
		.into_iter()
		.next()
		.ok_or_else(|| GuacdError::Protocol("'ready' instruction had no connection ID".into()))?;

	info!(%addr, %protocol, %connection_id, "guacd handshake complete");

	Ok(GuacdSession { connection_id, stream })
}

/// Build the capability instructions sent after `args` and before `connect`.
///
/// These tell guacd what the client supports so it can choose appropriate
/// codecs and features.
fn capability_instructions(width: u32, height: u32, dpi: u32) -> Vec<Instruction> {
	vec![
		// Screen geometry the client is requesting.
		Instruction::new("size", vec![
			width.to_string(),
			height.to_string(),
			dpi.to_string(),
		]),
		// Supported audio MIME types.  guacd picks one based on what the
		// protocol plugin supports; audio/L16 is broadly supported for RDP.
		Instruction::new("audio", vec![
			"audio/L8".into(),
			"audio/L16".into(),
		]),
		// No video passthrough in this implementation.
		Instruction::new("video", vec![]),
		// Supported image MIME types for screen tiles.
		Instruction::new("image", vec![
			"image/png".into(),
			"image/jpeg".into(),
			"image/webp".into(),
		]),
	]
}
