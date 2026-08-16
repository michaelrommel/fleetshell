//! Destination-rule matching.
//!
//! Each Valkey SET member is a TAB-delimited tuple written by the spooler
//! (`fleetshell-portal-dev/src/lib/server/infoproxy.ts`):
//!
//! ```text
//! <dns>\t<cidr>\t<port_from>\t<port_to>\t<protocol>
//! ```
//!
//! * `dns`        destination host/domain (empty = match by cidr only)
//! * `cidr`       IP or range in CIDR text, e.g. `10.0.0.0/8` or `1.2.3.4/32`
//!   (empty = match by dns only)
//! * `port_from`  lower bound (empty = any port)
//! * `port_to`    upper bound (= port_from for a single port; empty = any)
//! * `protocol`   freeform legacy label, e.g. `CONNECT / HTTPS` (advisory)

use std::net::IpAddr;

use ipnet::IpNet;

/// A parsed destination rule.
pub struct Rule<'a> {
	dns: &'a str,
	cidr: &'a str,
	port_from: Option<u16>,
	port_to: Option<u16>,
	protocol: &'a str,
}

impl<'a> Rule<'a> {
	/// Parse one SET member. Missing trailing fields are treated as empty.
	pub fn parse(member: &'a str) -> Self {
		let mut it = member.split('\t');
		let dns = it.next().unwrap_or("");
		let cidr = it.next().unwrap_or("");
		let port_from = it.next().unwrap_or("").trim().parse::<u16>().ok();
		let port_to = it.next().unwrap_or("").trim().parse::<u16>().ok();
		let protocol = it.next().unwrap_or("");
		Self { dns, cidr, port_from, port_to, protocol }
	}
}

/// The incoming proxy request, as passed by Squid on the helper's stdin line.
pub struct Request<'a> {
	/// Destination IP resolved by Squid (`%DST`), if any.
	pub dst_ip: Option<IpAddr>,
	/// Requested host/domain (`%>rd`, falling back to `%DST`), if any.
	pub dst_host: &'a str,
	/// Destination port (`%PORT`).
	pub port: Option<u16>,
	/// Request method (`%METHOD`, e.g. CONNECT / GET).
	pub method: &'a str,
}

/// Does `rule` permit `req`? `strict_proto` enforces the freeform protocol
/// label; by default protocol is advisory only (legacy labels vary).
pub fn rule_allows(rule: &Rule<'_>, req: &Request<'_>, strict_proto: bool) -> bool {
	// Destination: IP-in-CIDR OR host-suffix match.
	let mut dest_ok = false;
	if !rule.cidr.is_empty() {
		if let Ok(net) = rule.cidr.parse::<IpNet>() {
			let candidates = [req.dst_ip, req.dst_host.parse::<IpAddr>().ok()];
			if candidates.into_iter().flatten().any(|ip| net.contains(&ip)) {
				dest_ok = true;
			}
		}
	}
	if !dest_ok && !rule.dns.is_empty() && host_matches(rule.dns, req.dst_host) {
		dest_ok = true;
	}
	if !dest_ok {
		return false;
	}

	// Port range (empty from => any).
	if let Some(lo) = rule.port_from {
		let hi = rule.port_to.unwrap_or(lo);
		match req.port {
			Some(p) if lo <= p && p <= hi => {}
			_ => return false,
		}
	}

	// Protocol: advisory unless strict.
	if strict_proto && !rule.protocol.trim().is_empty() {
		let proto = rule.protocol.to_ascii_lowercase();
		if !proto.contains("any") && !req.method.is_empty()
			&& !proto.contains(&req.method.to_ascii_lowercase())
		{
			return false;
		}
	}

	true
}

/// Exact or domain-suffix match of `host` against `rule_dns`.
fn host_matches(rule_dns: &str, host: &str) -> bool {
	if host.is_empty() {
		return false;
	}
	let d = rule_dns.trim().trim_start_matches('.').to_ascii_lowercase();
	if d.is_empty() {
		return false;
	}
	let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
	h == d || h.ends_with(&format!(".{d}"))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn req<'a>(ip: &str, host: &'a str, port: u16, method: &'a str) -> Request<'a> {
		Request {
			dst_ip: ip.parse().ok(),
			dst_host: host,
			port: Some(port),
			method,
		}
	}

	#[test]
	fn cidr_and_port_match() {
		let rule = Rule::parse("\t10.0.0.0/8\t443\t443\tCONNECT / HTTPS");
		assert!(rule_allows(&rule, &req("10.1.2.3", "-", 443, "CONNECT"), false));
		assert!(!rule_allows(&rule, &req("11.1.2.3", "-", 443, "CONNECT"), false));
		assert!(!rule_allows(&rule, &req("10.1.2.3", "-", 8443, "CONNECT"), false));
	}

	#[test]
	fn dns_suffix_match() {
		let rule = Rule::parse("example.com\t\t\t\tHTTPS");
		assert!(rule_allows(&rule, &req("-", "www.example.com", 443, "GET"), false));
		assert!(rule_allows(&rule, &req("-", "example.com", 443, "GET"), false));
		assert!(!rule_allows(&rule, &req("-", "evilexample.com", 443, "GET"), false));
	}

	#[test]
	fn any_port_when_unset() {
		let rule = Rule::parse("\t192.168.0.0/16\t\t\t");
		assert!(rule_allows(&rule, &req("192.168.9.9", "-", 22, ""), false));
		assert!(rule_allows(&rule, &req("192.168.9.9", "-", 9999, ""), false));
	}

	#[test]
	fn strict_proto_enforced() {
		let rule = Rule::parse("host.local\t\t\t\tHTTPS");
		assert!(!rule_allows(&rule, &req("-", "host.local", 80, "FTP"), true));
		assert!(rule_allows(&rule, &req("-", "host.local", 80, "HTTPS"), true));
		// advisory by default -> method ignored
		assert!(rule_allows(&rule, &req("-", "host.local", 80, "FTP"), false));
	}
}
