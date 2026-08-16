//! `squid-infoproxy` -- a Squid `external_acl_type` helper for Info Proxy
//! destination authorization.
//!
//! Squid only sees the CLIENT IP at request time; device modality / product /
//! serial is resolved OFFLINE by the spooler
//! (`fleetshell-portal-dev/src/lib/server/infoproxy.ts` /
//! `scripts/spool-infoproxy.mjs`) into a per-source-IP allow-list in Valkey:
//!
//! ```text
//! SET  infoproxy:<proxy_type>:<source_ip>   members = allowed destinations
//! ```
//!
//! This helper does an O(1) `SMEMBERS` on the client IP's key and answers `OK`
//! iff any member matches the requested destination + port. A MISSING key =>
//! default DENY. Squid caches the verdict (ttl=...), so this runs once per
//! (src, dst, port, method) tuple.
//!
//! Squid configuration (INTERNET Squid shown; run a second instance with
//! `--proxy-type intranet` for the intranet Squid):
//!
//! ```text
//! external_acl_type infoproxy \
//!     ttl=60 negative_ttl=10 children-max=40 \
//!     %SRC %DST %PORT %METHOD %>rd \
//!     /usr/local/bin/squid-infoproxy --proxy-type internet
//! acl infoproxy_ok external infoproxy
//! http_access allow infoproxy_ok
//! http_access deny all
//! ```
//!
//! Input line fields (in the order requested above): `SRC DST PORT METHOD RD`.

mod matcher;
mod valkey;

use std::io::{self, BufRead, Write};

use matcher::{rule_allows, Request, Rule};
use valkey::{Valkey, ValkeyConfig};

struct Args {
	proxy_type: String,
	valkey_url: String,
	tls_insecure: bool,
	strict_proto: bool,
	concurrent: bool,
}

fn usage() -> ! {
	eprintln!(
		"squid-infoproxy -- Squid external_acl helper for Info Proxy\n\
		 \n\
		 USAGE:\n\
		 \x20 squid-infoproxy --proxy-type <intranet|internet> [options]\n\
		 \n\
		 OPTIONS:\n\
		 \x20 --proxy-type <t>   which Squid this instance serves (required)\n\
		 \x20 --valkey-url <url> redis(s):// URL (env VALKEY_URL, else rediss://localhost:6380)\n\
		 \x20 --tls-insecure     skip Valkey TLS cert validation (env VALKEY_TLS_REJECT_UNAUTHORIZED=false)\n\
		 \x20 --strict-proto     enforce the freeform protocol label (default: advisory)\n\
		 \x20 --concurrent       Squid concurrency: first field is a channel id echoed back\n\
		 \x20 -h, --help         this help"
	);
	std::process::exit(2);
}

fn parse_args() -> Args {
	let mut proxy_type: Option<String> = None;
	let mut valkey_url = std::env::var("VALKEY_URL").unwrap_or_else(|_| "rediss://localhost:6380".into());
	// Mirror the portal's convention: VALKEY_TLS_REJECT_UNAUTHORIZED=false => insecure.
	let mut tls_insecure = std::env::var("VALKEY_TLS_REJECT_UNAUTHORIZED")
		.map(|v| v == "false")
		.unwrap_or(false);
	let mut strict_proto = false;
	let mut concurrent = false;

	let mut it = std::env::args().skip(1);
	while let Some(arg) = it.next() {
		match arg.as_str() {
			"--proxy-type" => proxy_type = it.next(),
			"--valkey-url" => valkey_url = it.next().unwrap_or_else(|| usage()),
			"--tls-insecure" => tls_insecure = true,
			"--strict-proto" => strict_proto = true,
			"--concurrent" => concurrent = true,
			"-h" | "--help" => usage(),
			other => {
				eprintln!("squid-infoproxy: unknown argument '{other}'");
				usage();
			}
		}
	}

	let proxy_type = proxy_type.unwrap_or_else(|| {
		eprintln!("squid-infoproxy: --proxy-type is required");
		usage();
	});
	if proxy_type != "intranet" && proxy_type != "internet" {
		eprintln!("squid-infoproxy: --proxy-type must be 'intranet' or 'internet'");
		usage();
	}

	Args { proxy_type, valkey_url, tls_insecure, strict_proto, concurrent }
}

/// Decide OK/ERR for one request. `fields` = [SRC, DST, PORT, METHOD, RD].
fn decide(valkey: &mut Valkey, args: &Args, fields: &[&str]) -> &'static str {
	let get = |i: usize| fields.get(i).copied().unwrap_or("-");
	let src = get(0);
	let dst = get(1);
	let port_s = get(2);
	let method = get(3);
	let rd = get(4);

	if src.is_empty() || src == "-" {
		return "ERR";
	}
	let dst_ip = if dst != "-" && !dst.is_empty() { dst.parse().ok() } else { None };
	// Prefer the requested host; fall back to the (possibly IP) destination.
	let dst_host = if rd != "-" && !rd.is_empty() {
		rd
	} else if dst != "-" {
		dst
	} else {
		""
	};
	let port = port_s.parse::<u16>().ok();

	let key = format!("infoproxy:{}:{}", args.proxy_type, src);
	let members = match valkey.smembers(&key) {
		Ok(m) => m,
		Err(e) => {
			// Fail closed on any Valkey error.
			eprintln!("squid-infoproxy: valkey error for {key}: {e}");
			return "ERR";
		}
	};
	if members.is_empty() {
		return "ERR";
	}

	let req = Request { dst_ip, dst_host, port, method };
	for m in &members {
		if rule_allows(&Rule::parse(m), &req, args.strict_proto) {
			return "OK";
		}
	}
	"ERR"
}

fn main() {
	let args = parse_args();
	let cfg = match ValkeyConfig::parse(&args.valkey_url, args.tls_insecure) {
		Ok(c) => c,
		Err(e) => {
			eprintln!("squid-infoproxy: {e}");
			std::process::exit(2);
		}
	};
	let mut valkey = match Valkey::new(cfg) {
		Ok(v) => v,
		Err(e) => {
			eprintln!("squid-infoproxy: {e}");
			std::process::exit(2);
		}
	};

	let stdin = io::stdin();
	let mut stdout = io::stdout();
	for line in stdin.lock().lines() {
		let line = match line {
			Ok(l) => l,
			Err(_) => break,
		};
		if line.trim().is_empty() {
			continue;
		}
		let mut tokens: Vec<&str> = line.split_whitespace().collect();

		// Squid concurrency: the first token is a channel id echoed back verbatim.
		let channel = if args.concurrent && !tokens.is_empty() {
			Some(tokens.remove(0))
		} else {
			None
		};

		let verdict = decide(&mut valkey, &args, &tokens);
		let out = match channel {
			Some(ch) => format!("{ch} {verdict}\n"),
			None => format!("{verdict}\n"),
		};
		if stdout.write_all(out.as_bytes()).is_err() || stdout.flush().is_err() {
			break;
		}
	}
}
