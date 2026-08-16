#!/usr/bin/env python3
"""import_infoproxy.py -- load the legacy Info Proxy (Squid destination
authorization) into proxy_destination_rule_collection / proxy_destination_rule /
proxy_destination_binding. See docs/product_admin.md sec 4 + migrate_infoproxy.sql.

Sources (gitignored, old_database/):
  infoproxy_rules_intranet.txt  -- INTRANET: named collections + their rules, then
      an assignment table (mostly ANY/ANY inline global rules + a couple of
      collection bindings).
  infoproxy_rules_internet.txt  -- INTERNET: named collections + their rules
      (definitions only; no assignments).
  table-export.html            -- INTERNET assignment table (the authoritative HTML
      export of the "2226 items" grid): clean 10-column rows -- Customer System |
      Product Model | Target IP | Target DNS | Target Port | Protocol | Device
      Authorization Group | Modified by | Annotations | Remove. Replaces the older
      scrambled PDF text extraction.

Model produced:
  - collection  = named container (proxy_type intranet|internet). Loose ANY/ANY
    inline target rules (not in any named collection) go into a synthetic
    '<Proxy> Global (imported)' collection bound ANY/ANY.
  - rule        = one allowed target (cidr and/or dns + optional port range + protocol).
  - binding     = a collection applied to a device (Customer System NAME resolved
    via sysname_device.map.json) and/or a product MODEL (by name), or ANY.

Device attribution needs sysname_device.map.json (NAME -> device UUID), written by
load.py's stage_devices on every reload. A --dry-run works without it (uses
RDSERVICEDSYSTEM to report device-resolvability).

Env: IMPORT_GLOBAL_DSN.  Usage: python import_infoproxy.py [--dry-run]
"""

from __future__ import annotations
import argparse, gzip, html, ipaddress, json, os, re, sys
from collections import Counter

import psycopg

HERE = os.path.dirname(os.path.abspath(__file__))
OLD = os.path.join(HERE, "old_database")
INTRANET_FILE = os.path.join(OLD, "infoproxy_rules_intranet.txt")
INTERNET_COLLS_FILE = os.path.join(OLD, "infoproxy_rules_internet.txt")
INTERNET_HTML_FILE = os.path.join(OLD, "table-export.html")
SYSNAME_MAP = os.path.join(HERE, "sysname_device.map.json")
RDSYS = os.path.join(OLD, "RDSERVICEDSYSTEM.csv.gz")

DEFAULT_PROTOCOL = "CONNECT / HTTPS"          # fallback when a rule omits protocol
GLOBAL_COLLECTION = {"intranet": "Intranet Global (imported)",
                     "internet": "Internet Global (imported)"}


# --- rule helpers -----------------------------------------------------------
def as_cidr(ip: str) -> str | None:
    ip = (ip or "").strip()
    if not ip:
        return None
    try:
        ipaddress.ip_network(ip, strict=False)   # accepts host or a.b.c.d/nn
        return ip
    except ValueError:
        return None


def mk_rule(ip: str, dns: str, port: str, proto: str) -> dict | None:
    cidr = as_cidr(ip)
    dns = (dns or "").strip() or None
    if not cidr and not dns:
        return None                              # CHECK: needs cidr and/or dns
    p = (port or "").strip()
    pf = int(p) if p.isdigit() else None
    proto = (proto or "").strip() or DEFAULT_PROTOCOL
    return {"cidr": cidr, "dns": dns, "port_from": pf, "port_to": pf, "protocol": proto}


# --- collection-definition parsing (both intranet + internet files) ---------
def parse_collections(path: str):
    """Return (named: {name:[rules]}, inline_rules:[rule], bindings:[(cust,model,dag)]).
    Named collections come from 'Collection:' blocks. If an assignment table
    ('Customer System\\t...') is present (intranet), its rows become either inline
    ANY/ANY rules or collection bindings."""
    named: dict[str, list] = {}
    inline: list = []
    bindings: list = []
    cur = None
    mode = None            # 'rules' | 'assign'
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.rstrip("\n")
        s = line.strip()
        if s.startswith("Collection:") or s.startswith("Collections:"):
            cur = s.split(":", 1)[1].strip()
            named.setdefault(cur, [])
            mode = "rules"
            continue
        if line.startswith("Customer System\t"):
            mode = "assign"
            continue
        if line.startswith("Target IP"):        # per-collection rule header
            continue
        if not s:
            continue
        cols = line.split("\t")
        if mode == "rules" and cur is not None:
            r = mk_rule(cols[0] if len(cols) > 0 else "",
                        cols[1] if len(cols) > 1 else "",
                        cols[2] if len(cols) > 2 else "",
                        cols[3] if len(cols) > 3 else "")
            if r:
                named[cur].append(r)
        elif mode == "assign":
            # Customer System, Product Model, IP, DNS, Port, Protocol, DAG, ...
            cust = cols[0].strip() if len(cols) > 0 else ""
            model = cols[1].strip() if len(cols) > 1 else ""
            ip = cols[2] if len(cols) > 2 else ""
            dns = cols[3] if len(cols) > 3 else ""
            port = cols[4] if len(cols) > 4 else ""
            proto = cols[5] if len(cols) > 5 else ""
            dag = cols[6].strip() if len(cols) > 6 else ""
            if dag:
                bindings.append((cust, model, dag))
            else:
                r = mk_rule(ip, dns, port, proto)
                if r:
                    inline.append(r)             # ANY/ANY global rule
    return named, inline, bindings


# --- internet assignment-table parsing (authoritative HTML export) ----------
def _html_rows(path: str):
    """Yield the cell lists of each <tr> in the export (tags stripped, entities
    decoded, nbsp -> space)."""
    raw = open(path, encoding="utf-8", errors="replace").read()
    for tr in re.findall(r"<tr\b[^>]*>(.*?)</tr>", raw, re.S):
        tds = re.findall(r"<td\b[^>]*>(.*?)</td>", tr, re.S)
        yield [html.unescape(re.sub(r"<[^>]+>", " ", t)).replace("\xa0", " ").strip()
               for t in tds]


def parse_internet_html(path: str, coll_names: set[str]):
    """Return (inline_rules, bindings[(system,model,dag)]).

    Columns: 0 Customer System | 1 Product Model | 2 IP | 3 DNS | 4 Port |
    5 Protocol | 6 Device Authorization Group | 7 Modified by | 8 Annotations |
    9 Remove. A row is a binding when the DAG cell names a known collection;
    otherwise (with a target) it is an ANY/ANY inline global rule."""
    inline, bindings = [], []
    for c in _html_rows(path):
        if len(c) < 7 or c[0] == "Customer System":     # header / malformed
            continue
        system = c[0].strip() or "ANY"
        model = c[1].strip() or "ANY"
        dag = c[6].strip()
        if dag in coll_names:
            bindings.append((system if system != "ANY" else "ANY",
                             model if model != "ANY" else "ANY", dag))
        elif not dag:
            r = mk_rule(c[2], c[3], c[4], c[5])          # real protocol from col 5
            if r:
                inline.append(r)
    return inline, bindings


# --- DB + maps --------------------------------------------------------------
def load_models(g) -> dict[str, str]:
    with g.cursor() as c:
        c.execute("SELECT name, id FROM product WHERE kind='model' AND name<>''")
        m: dict[str, str] = {}
        for name, pid in c.fetchall():
            m.setdefault(name, str(pid))
        return m


def load_sysname_map(dry_run: bool):
    """NAME -> device uuid. For --dry-run without the map, fall back to a NAME set
    from RDSERVICEDSYSTEM (existence only, value = sentinel 'DRY')."""
    if os.path.exists(SYSNAME_MAP):
        with open(SYSNAME_MAP) as f:
            return json.load(f), False
    if dry_run and os.path.exists(RDSYS):
        names = {}
        with gzip.open(RDSYS, "rt", encoding="utf-8", errors="replace") as f:
            next(f)
            for line in f:
                cols = line.split(";")
                if len(cols) > 1 and cols[1].strip():
                    names[cols[1].strip()] = "DRY"
        return names, True
    sys.exit(f"missing {SYSNAME_MAP} (run a load.py reload first, or use --dry-run)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="parse + resolve + report; no writes")
    a = ap.parse_args()

    dsn = os.environ.get("IMPORT_GLOBAL_DSN")
    if not dsn:
        sys.exit("IMPORT_GLOBAL_DSN is not set")
    g = psycopg.connect(dsn)

    db_models = load_models(g)
    dbmodel_names = set(db_models)
    sysmap, dry_map = load_sysname_map(a.dry_run)

    # -- parse sources --
    intra_named, intra_inline, intra_bindings = parse_collections(INTRANET_FILE)
    inet_named, _, _ = parse_collections(INTERNET_COLLS_FILE)
    coll_names = set(inet_named)
    inet_inline, inet_pdf_bindings = parse_internet_html(INTERNET_HTML_FILE, coll_names)

    # -- assemble collections (name, proxy_type) -> rules --
    collections: dict[tuple[str, str], list] = {}
    for name, rules in intra_named.items():
        collections[(name, "intranet")] = rules
    for name, rules in inet_named.items():
        collections[(name, "internet")] = rules
    if intra_inline:
        collections[(GLOBAL_COLLECTION["intranet"], "intranet")] = intra_inline
    if inet_inline:
        collections[(GLOBAL_COLLECTION["internet"], "internet")] = inet_inline

    # -- assemble bindings: (collection_key) -> set of (device_id, product_id) --
    bindings: dict[tuple[str, str], set] = {}
    stats = Counter()

    def add_binding(coll_key, device_id, product_id):
        bindings.setdefault(coll_key, set()).add((device_id, product_id))

    # intranet: named + synthetic global, all ANY/ANY; plus its assignment-table bindings
    for name in intra_named:
        add_binding((name, "intranet"), None, None); stats["intranet_global_binding"] += 1
    if intra_inline:
        add_binding((GLOBAL_COLLECTION["intranet"], "intranet"), None, None)
    for cust, model, dag in intra_bindings:
        key = (dag, "intranet")
        if key not in collections:
            stats["intranet_binding_unknown_collection"] += 1
            continue
        add_binding(key, None, None); stats["intranet_binding"] += 1

    # internet synthetic global
    if inet_inline:
        add_binding((GLOBAL_COLLECTION["internet"], "internet"), None, None)

    # internet PDF bindings -> device (preferred) / model / global
    for system, model, dag in inet_pdf_bindings:
        key = (dag, "internet")
        if key not in collections:
            stats["binding_unknown_collection"] += 1
            continue
        if system != "ANY":
            dev = sysmap.get(system)
            if dev:
                add_binding(key, None if dry_map else dev, None)
                stats["device_binding"] += 1
                continue
            stats["device_unresolved"] += 1        # system named but not found -> skip (precise)
            continue
        # system == ANY
        if model != "ANY" and model in db_models:
            add_binding(key, None, db_models[model]); stats["model_binding"] += 1
        elif model == "ANY":
            add_binding(key, None, None); stats["global_binding"] += 1
        else:
            stats["model_unresolved"] += 1

    # -- report --
    n_rules = sum(len(r) for r in collections.values())
    n_bind = sum(len(v) for v in bindings.values())
    print(f"collections: {len(collections)}  rules: {n_rules}  bindings: {n_bind}")
    print("  by proxy_type:",
          dict(Counter(pt for (_, pt) in collections)))
    print("  binding stats:", dict(stats))
    if dry_map:
        print("  (dry-run: sysname map absent; device bindings counted, not resolved to UUIDs)")

    if a.dry_run:
        print("dry-run: no writes")
        g.close()
        return

    # -- write --
    with g.cursor() as c:
        c.execute("TRUNCATE proxy_destination_rule_collection CASCADE")   # cascades rules + bindings
        coll_id: dict[tuple[str, str], str] = {}
        for (name, ptype), rules in collections.items():
            c.execute(
                "INSERT INTO proxy_destination_rule_collection (name, proxy_type) VALUES (%s,%s) RETURNING id",
                (name, ptype))
            cid = c.fetchone()[0]
            coll_id[(name, ptype)] = cid
            for r in rules:
                c.execute(
                    "INSERT INTO proxy_destination_rule "
                    "(collection_id, target_cidr, target_dns, target_port_from, target_port_to, protocol) "
                    "VALUES (%s, %s::cidr, %s, %s, %s, %s)",
                    (cid, r["cidr"], r["dns"], r["port_from"], r["port_to"], r["protocol"]))
        n_written = 0
        for key, pairs in bindings.items():
            cid = coll_id[key]
            for device_id, product_id in pairs:
                c.execute(
                    "INSERT INTO proxy_destination_binding (collection_id, device_id, product_id) "
                    "VALUES (%s,%s,%s)", (cid, device_id, product_id))
                n_written += 1
    g.commit()
    print(f"wrote {len(coll_id)} collections, {n_rules} rules, {n_written} bindings")
    g.close()


if __name__ == "__main__":
    main()
