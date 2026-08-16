# squid-infoproxy

A Squid [`external_acl_type`](http://www.squid-cache.org/Doc/config/external_acl_type/)
helper that authorizes proxy requests against the FleetShell **Info Proxy**
destination allow-lists in Valkey.

Squid only sees the **client (source) IP** at request time. The device's
modality / product / serial is resolved OFFLINE by the portal spooler
(`fleetshell-portal-dev/src/lib/server/infoproxy.ts`, or the standalone
`fleetshell-portal-dev/scripts/spool-infoproxy.mjs`) into a per-source-IP
allow-list in Valkey:

```
SET  infoproxy:<proxy_type>:<source_ip>   members = allowed destinations
```

* `proxy_type` = `intranet` | `internet` (the two Squids are independent)
* `source_ip`  = `device.ip_address` (the Squid client IP)

Each SET member is a TAB-delimited destination tuple:

```
<dns>\t<cidr>\t<port_from>\t<port_to>\t<protocol>
```

| field       | meaning                                                        |
|-------------|----------------------------------------------------------------|
| `dns`       | destination host/domain (empty = match by `cidr` only)         |
| `cidr`      | IP or range, e.g. `10.0.0.0/8` or `1.2.3.4/32` (empty = by dns)|
| `port_from` | lower bound (empty = any port)                                 |
| `port_to`   | upper bound (= `port_from` for a single port; empty = any)     |
| `protocol`  | freeform legacy label, e.g. `CONNECT / HTTPS` (advisory)       |

The helper does an O(1) `SMEMBERS` on the client IP's key and answers `OK` iff
any member matches the requested destination + port. A **missing key => default
DENY**. Squid caches each verdict (`ttl=...`), so the helper runs once per
`(src, dst, port, method)` tuple.

## Design notes

* Pure Rust, blocking, no async runtime -- a Squid helper is a line-at-a-time
  stdin/stdout loop.
* TLS to `rediss://` uses **rustls on the `ring` provider** (consistent with the
  gateway; no aws_lc_rs). We hand-roll the tiny slice of RESP we need
  (`AUTH`/`SELECT`/`SMEMBERS`) rather than pull in the `redis` crate, whose
  rustls feature would drag in the aws_lc_rs provider and collide with `ring`.
* Fails **closed**: any Valkey/transport error yields `ERR` (deny).

## Build

```bash
cargo build -p squid-infoproxy --release
# binary: target/release/squid-infoproxy
```

## Configuration (CLI)

```
squid-infoproxy --proxy-type <intranet|internet> [options]

  --proxy-type <t>   which Squid this instance serves (required)
  --valkey-url <url> redis(s):// URL
                     (env VALKEY_URL, else rediss://localhost:6380)
  --tls-insecure     skip Valkey TLS cert validation
                     (env VALKEY_TLS_REJECT_UNAUTHORIZED=false)
  --strict-proto     enforce the freeform protocol label (default: advisory)
  --concurrent       Squid concurrency: first field is a channel id echoed back
  -h, --help
```

The `--valkey-url` may embed ACL credentials: `rediss://user:pass@host:6379`.

## Squid configuration

Run **one instance per proxy type**. INTERNET Squid shown:

```
external_acl_type infoproxy \
    ttl=60 negative_ttl=10 children-max=40 \
    %SRC %DST %PORT %METHOD %>rd \
    /usr/local/bin/squid-infoproxy --proxy-type internet

acl infoproxy_ok external infoproxy
http_access allow infoproxy_ok
http_access deny all
```

The format string order (`%SRC %DST %PORT %METHOD %>rd`) is the input line the
helper expects: `SRC DST PORT METHOD RD`.

## Refreshing the allow-lists

Whenever Info Proxy master data changes in the portal, re-spool Valkey (the
portal's **Save to Valkey** button, or a scheduled run of
`node scripts/spool-infoproxy.mjs` from the portal directory). Squid picks up the
new verdicts as its cached entries expire (`ttl`).
