//! test-guac — Guacamole / guacd smoke-test tool.
//!
//! Two modes:
//!
//! **Direct** (default) — connects straight to guacd, drives the full
//! Guacamole opening handshake itself, then reads drawing instructions.
//! Proves that guacd can reach the target device.
//!
//! **Gateway** (`--gateway <addr>`) — connects to the fleetshell-gateway,
//! sends the JSON handshake line with `"guac": true`, reads `200 CONNECTED`,
//! then reads drawing instructions.  Proves the new gateway guac branch:
//! the gateway drives the guacd handshake internally.
//!
//! # Usage
//!
//! ```text
//! test-guac [--gateway <addr>] <host> [port] [username] [password] [num-instructions]
//!
//! Environment variables:
//!   GUACD_ADDR     guacd address for direct mode   default: 127.0.0.1:4822
//!   PROTOCOL       rdp or vnc                      default: rdp
//!   TOKEN          JWT for gateway mode             required with --gateway
//!   GATEWAY_NAME   'gateway' field in handshake    default: test
//! ```
//!
//! # Build (static musl binary for the container)
//!
//! ```bash
//! cargo build --release -p test-guac --target x86_64-unknown-linux-musl
//! ```
//!
//! # In-container: gateway mode (tests the new guac branch in handler.rs)
//!
//! ```bash
//! # The gateway receives plain TCP from the NLB — no TLS needed from inside
//! # the same container.
//! TOKEN="<jwt-from-portal>" GATEWAY_NAME="atlanta-01" \
//!   ./test-guac --gateway 127.0.0.1:8443 172.16.28.109 3389 Administrator ''
//! ```

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use std::collections::HashMap;

// ── Guacamole protocol (inline, no external deps) ─────────────────────────────

fn encode_element(s: &str) -> String {
	format!("{}.{}", s.len(), s)
}

fn encode_instruction(opcode: &str, args: &[&str]) -> String {
	let mut out = encode_element(opcode);
	for arg in args {
		out.push(',');
		out.push_str(&encode_element(arg));
	}
	out.push(';');
	out
}

fn send(stream: &mut TcpStream, opcode: &str, args: &[&str]) -> io::Result<()> {
	let wire = encode_instruction(opcode, args);
	stream.write_all(wire.as_bytes())?;
	stream.flush()
}

fn read_byte(stream: &mut TcpStream) -> io::Result<u8> {
	let mut b = [0u8; 1];
	stream.read_exact(&mut b)?;
	Ok(b[0])
}

fn recv(stream: &mut TcpStream) -> io::Result<(String, Vec<String>)> {
	let mut elements: Vec<String> = Vec::new();
	loop {
		let mut digits: Vec<u8> = Vec::with_capacity(8);
		loop {
			let b = read_byte(stream)?;
			match b {
				b'0'..=b'9' => digits.push(b),
				b'.' => break,
				other => return Err(io::Error::new(
					io::ErrorKind::InvalidData,
					format!("expected digit or '.', got 0x{other:02x}"),
				)),
			}
		}
		let len: usize = std::str::from_utf8(&digits).unwrap().parse().unwrap();
		let mut value = vec![0u8; len];
		stream.read_exact(&mut value)?;
		elements.push(String::from_utf8_lossy(&value).into_owned());
		match read_byte(stream)? {
			b',' => continue,
			b';' => break,
			other => return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				format!("expected ',' or ';', got 0x{other:02x}"),
			)),
		}
	}
	let opcode = elements.remove(0);
	Ok((opcode, elements))
}

fn print_instruction(direction: &str, opcode: &str, args: &[String]) {
	let formatted: Vec<String> = args.iter().map(|a| {
		if a.len() > 40 { format!("{}…({} bytes)", &a[..40], a.len()) }
		else             { a.clone() }
	}).collect();
	if formatted.is_empty() {
		println!("{direction} {opcode}");
	} else {
		println!("{direction} {opcode}  [{}]", formatted.join(", "));
	}
}

// ── JSON helpers (no external deps) ──────────────────────────────────────────

/// Produce a properly escaped JSON string literal (including the quotes).
fn json_str(s: &str) -> String {
	let mut out = String::with_capacity(s.len() + 2);
	out.push('"');
	for c in s.chars() {
		match c {
			'"'  => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c    => out.push(c),
		}
	}
	out.push('"');
	out
}

/// Build the gateway JSON handshake line (newline-terminated).
fn build_gateway_handshake(
	host:         &str,
	protocol:     &str,
	port:         u16,
	token:        &str,
	username:     &str,
	password:     &str,
	width:        u32,
	height:       u32,
	dpi:          u32,
	gateway_name: &str,
) -> String {
	format!(
		"{{\
			\"target\":{},\
			\"application\":{},\
			\"port\":{},\
			\"token\":{},\
			\"guac\":true,\
			\"username\":{},\
			\"password\":{},\
			\"width\":{},\
			\"height\":{},\
			\"dpi\":{},\
			\"gateway\":{},\
			\"path\":\"/service/tunnel/\",\
			\"e2ecrypt\":false\
		}}\n",
		json_str(host),
		json_str(protocol),
		port,
		json_str(token),
		json_str(username),
		json_str(password),
		width, height, dpi,
		json_str(gateway_name),
	)
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
	let argv: Vec<String> = std::env::args().collect();

	if argv.iter().any(|a| a == "--help" || a == "-h") {
		println!(
			"Usage: test-guac [--gateway <addr>] <host> [port] [username] [password] [num]\n\
			 \n\
			 Direct mode  (no --gateway): connect straight to guacd\n\
			 Gateway mode (--gateway):    send JSON handshake to fleetshell-gateway\n\
			 \n\
			 Env (direct):   GUACD_ADDR  guacd address        (default 127.0.0.1:4822)\n\
			 Env (both):     PROTOCOL    rdp or vnc            (default rdp)\n\
			 Env (gateway):  TOKEN       JWT                   (required)\n\
			 Env (gateway):  GATEWAY_NAME  gateway field value (default: test)"
		);
		return;
	}

	// ── Parse --gateway / -g flag ─────────────────────────────────────────────
	let mut gateway_addr: Option<String> = None;
	let mut positional: Vec<String> = Vec::new();
	let mut iter = argv.iter().skip(1).peekable();
	while let Some(arg) = iter.next() {
		if arg == "--gateway" || arg == "-g" {
			gateway_addr = iter.next().cloned();
		} else {
			positional.push(arg.clone());
		}
	}

	// ── Shared positional args ────────────────────────────────────────────────
	let host = match positional.first() {
		Some(h) => h.clone(),
		None => {
			eprintln!("error: target host is required");
			eprintln!("Usage: test-guac [--gateway <addr>] <host> [port] [username] [password] [num]");
			std::process::exit(1);
		}
	};
	let port: u16           = positional.get(1).and_then(|s| s.parse().ok()).unwrap_or(3389);
	let username            = positional.get(2).cloned().unwrap_or_else(|| "Administrator".into());
	let password            = positional.get(3).cloned().unwrap_or_default();
	let num_instructions: usize = positional.get(4).and_then(|s| s.parse().ok()).unwrap_or(20);

	let protocol     = std::env::var("PROTOCOL").unwrap_or_else(|_| "rdp".into());

	match gateway_addr {
		Some(ref gw) => {
			// ── Gateway mode ──────────────────────────────────────────────────
			let token        = std::env::var("TOKEN").unwrap_or_default();
			let gateway_name = std::env::var("GATEWAY_NAME")
				.unwrap_or_else(|_| "test".into());

			println!("━━━ test-guac (gateway mode) ━━━━━━━━━━━━━━━━━━━━━━━━━━");
			println!("  gateway     : {gw}");
			println!("  protocol    : {protocol}");
			println!("  target      : {host}:{port}");
			println!("  username    : {username}");
			println!("  token       : {} chars", token.len());
			println!("  instructions: {num_instructions}");
			println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

			if token.is_empty() {
				eprintln!("\nerror: TOKEN env var is required in gateway mode");
				eprintln!("  Get a token from the portal: POST /api/tunnel/sign");
				std::process::exit(1);
			}

			if let Err(e) = run_via_gateway(
				gw, &protocol, &host, port,
				&username, &password, &token, &gateway_name,
				1280, 800, 96,
				num_instructions,
			) {
				eprintln!("\nerror: {e}");
				std::process::exit(1);
			}
		}
		None => {
			// ── Direct guacd mode ─────────────────────────────────────────────
			let guacd_addr = std::env::var("GUACD_ADDR")
				.unwrap_or_else(|_| "127.0.0.1:4822".into());

			println!("━━━ test-guac (direct guacd mode) ━━━━━━━━━━━━━━━━━━━━");
			println!("  guacd       : {guacd_addr}");
			println!("  protocol    : {protocol}");
			println!("  target      : {host}:{port}");
			println!("  username    : {username}");
			println!("  instructions: {num_instructions}");
			println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

			if let Err(e) = run_direct(
				&guacd_addr, &protocol, &host, port,
				&username, &password,
				num_instructions,
			) {
				eprintln!("\nerror: {e}");
				std::process::exit(1);
			}
		}
	}
}

// ── Mode 1: direct to guacd ───────────────────────────────────────────────────

fn run_direct(
	guacd_addr: &str,
	protocol:   &str,
	host:       &str,
	port:       u16,
	username:   &str,
	password:   &str,
	num:        usize,
) -> io::Result<()> {
	// 1. Connect to guacd
	print!("\n[1/5] connecting to guacd at {guacd_addr} … ");
	io::stdout().flush()?;
	let mut stream = TcpStream::connect(guacd_addr)?;
	stream.set_read_timeout(Some(Duration::from_secs(5)))?;
	println!("ok");

	// 2. select
	println!("\n[2/5] select");
	print_instruction("→", "select", &[protocol.into()]);
	send(&mut stream, "select", &[protocol])?;

	let (opcode, args) = recv(&mut stream)?;
	print_instruction("←", &opcode, &args);
	if opcode != "args" {
		return Err(io::Error::new(io::ErrorKind::InvalidData,
			format!("expected 'args', got '{opcode}'")));
	}
	let param_names = args;
	println!("    guacd expects {} parameters", param_names.len());

	// 3. Capabilities
	println!("\n[3/5] capabilities");
	for (op, a) in &[
		("size",  vec!["1280", "800", "96"]),
		("audio", vec!["audio/L8", "audio/L16"]),
		("video", vec![]),
		("image", vec!["image/png", "image/jpeg", "image/webp"]),
	] {
		print_instruction("→", op, &a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
		send(&mut stream, op, a)?;
	}

	// 4. connect
	println!("\n[4/5] connect");
	let mut value_map: HashMap<&str, &str> = HashMap::new();
	let port_s = port.to_string();
	value_map.insert("hostname",    host);
	value_map.insert("port",        &port_s);
	value_map.insert("username",    username);
	value_map.insert("password",    password);
	value_map.insert("security",    "any");
	value_map.insert("ignore-cert", "true");
	value_map.insert("width",       "1280");
	value_map.insert("height",      "800");
	value_map.insert("dpi",         "96");

	let connect_args: Vec<&str> = param_names.iter()
		.map(|n| *value_map.get(n.as_str()).unwrap_or(&""))
		.collect();
	println!("→ connect  [{} values]", connect_args.len());
	send(&mut stream, "connect", &connect_args)?;

	// 5. ready
	let (opcode, args) = recv(&mut stream)?;
	print_instruction("←", &opcode, &args);
	if opcode != "ready" {
		return Err(io::Error::new(io::ErrorKind::InvalidData,
			format!("expected 'ready', got '{opcode}'")));
	}
	let cid = args.first().map(|s| s.as_str()).unwrap_or("<none>");
	println!("\n✓ guacd handshake complete — connection_id = {cid}");

	read_instructions(&mut stream, num, "guacd")
}

// ── Mode 2: via fleetshell-gateway ────────────────────────────────────────────

fn run_via_gateway(
	gateway_addr: &str,
	protocol:     &str,
	host:         &str,
	port:         u16,
	username:     &str,
	password:     &str,
	token:        &str,
	gateway_name: &str,
	width:        u32,
	height:       u32,
	dpi:          u32,
	num:          usize,
) -> io::Result<()> {
	// 1. TCP connect to gateway
	// Inside the container the gateway receives plain TCP (the NLB terminates
	// TLS), so no TLS library is needed here.
	print!("\n[1/3] connecting to gateway at {gateway_addr} … ");
	io::stdout().flush()?;
	let mut stream = TcpStream::connect(gateway_addr)?;
	stream.set_read_timeout(Some(Duration::from_secs(10)))?;
	println!("ok");

	// 2. Send JSON handshake line
	println!("\n[2/3] gateway handshake");
	let line = build_gateway_handshake(
		host, protocol, port, token, username, password,
		width, height, dpi, gateway_name,
	);
	println!("→ {{target:{host:?}, application:{protocol:?}, port:{port}, guac:true, \
	           username:{username:?}, width:{width}, height:{height}, dpi:{dpi}}}");
	stream.write_all(line.as_bytes())?;
	stream.flush()?;

	// 3. Read gateway status line (e.g. "200 CONNECTED")
	let mut status = String::new();
	loop {
		let mut b = [0u8; 1];
		stream.read_exact(&mut b)?;
		if b[0] == b'\n' { break; }
		status.push(b[0] as char);
	}
	println!("← {status}");

	if status.starts_with("401") {
		return Err(io::Error::new(io::ErrorKind::PermissionDenied,
			"gateway rejected: invalid or expired JWT (401 UNAUTHORIZED)"));
	}
	if status.starts_with("403") {
		return Err(io::Error::new(io::ErrorKind::PermissionDenied,
			"gateway rejected: JWT does not cover this target/port (403 FORBIDDEN)"));
	}
	if !status.starts_with("200") {
		return Err(io::Error::new(io::ErrorKind::Other,
			format!("gateway rejected: {status}")));
	}

	println!("\n✓ gateway accepted — guacd handshake was handled by the gateway");
	println!("  (the gateway connected to guacd, ran select→args→connect→ready)");

	read_instructions(&mut stream, num, "gateway→guacd")
}

// ── Shared: read and print N Guacamole instructions ───────────────────────────

fn read_instructions(stream: &mut TcpStream, num: usize, source: &str) -> io::Result<()> {
	println!("\n[reading up to {num} Guacamole instructions from {source} …]");
	println!("  (30 s timeout per instruction)\n");
	stream.set_read_timeout(Some(Duration::from_secs(30)))?;

	let mut count  = 0usize;
	let mut errors = 0usize;

	while count < num {
		match recv(stream) {
			Ok((opcode, args)) => {
				count += 1;
				print!("  [{count:>3}] ");
				print_instruction("←", &opcode, &args);
				if opcode == "error" {
					eprintln!("\n✗ error instruction received");
					errors += 1;
					break;
				}
			}
			Err(e) if e.kind() == io::ErrorKind::WouldBlock
			       || e.kind() == io::ErrorKind::TimedOut => {
				println!("\n(timeout — no further instructions in 30 s)");
				break;
			}
			Err(e) => return Err(e),
		}
	}

	println!("\n━━━ summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	if errors > 0 {
		println!("  ✗ session failed");
	} else {
		println!("  ✓ {count} instruction(s) received from {source}");
		println!("  ✓ pipeline is working");
	}
	println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

	Ok(())
}
