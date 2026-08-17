#!/usr/bin/env python3
"""import_subscriptions.py -- load File Subscriptions from the NORMALIZED second
export (RDSUBSCRIBER / RDSUBSCRIPTION / RDSUBSCRIPTIONLIST) into the master-data
tables (subscriber_server / subscription / subscription_server).

Replaces the old xlsx overview importer: the normalized tables are richer and more
complete -- they carry the real delivery method, ADLS/S3 targets, data root,
use-partno-folder, use-case and activated flags that the xlsx importer had to
DEFAULT. Standalone + self-contained: it TRUNCATEs the three tables and rebuilds,
resolving product/modality by NAME against the LIVE product tree (the id maps are
destroyed after load.py), so it can be re-run at any time WITHOUT a full reload.

Source (old_database/second_load/*.csv.gz):
  RDSUBSCRIBER       -> subscriber_server (delivery target)
  RDSUBSCRIPTION     -> subscription      (file matcher: pattern + modality/product)
  RDSUBSCRIPTIONLIST -> subscription_server (the attach matrix)

Field mapping:
  subscriber_server : name=NAME, ip_address=IPADDRESS, country=<ISO of COUNTRYID>,
    delivery_method=(DELIVERYMETHOD 2->scp, 7->adls; AWSBUCKET->s3),
    root_path=DATAROOT, use_partno_folder=(TARGETDIRECTORYMODE=='1'),
    container_path=AZURECONTAINER, use_case=(USECASETYPE 1->compliance else internal),
    activated=(ACTIVATED=='1'), comment=<anon ANNOTATIONS>,
    auth=<structural, non-secret bits; PWID/AUTHIDENT secrets are NOT in the export
         -> {} (admin/password-store fills them, like PSK / service keys)>.
  subscription : name=NAME, pattern=NAMEPATTERN, negate=(TYPEPATTERN bit-4 set),
    PRODUCTID -> resolve by NAME: a product node -> product_id (+ its modality),
    a modality node -> modality_id.

Anonymization honors the SAME ANONYMIZE switch as load.py: only the free-text
ANNOTATIONS is PII (contacts) -> placeholder when on, raw when off. The IP, root
paths and container names pass through (operational, not PII).

Env:  IMPORT_GLOBAL_DSN ; ANONYMIZE (1 default)
Usage: IMPORT_GLOBAL_DSN=... python import_subscriptions.py [--dry-run]
"""

from __future__ import annotations
import argparse, csv, gzip, os, sys

import psycopg

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "old_database", "second_load")
SRC_FALLBACK = os.path.join(HERE, "old_database", "first_load")

ANONYMIZE = os.environ.get("ANONYMIZE", "1").strip().lower() not in ("0", "false", "no", "off")
ANON_TEXT_PLACEHOLDER = "<content was anonymized during seeding>"


def read(name):
    p = os.path.join(SRC, name + ".csv.gz")
    if not os.path.exists(p):
        p = os.path.join(SRC_FALLBACK, name + ".csv.gz")
    with gzip.open(p, "rt", encoding="utf-8", newline="") as f:
        yield from csv.DictReader(f, delimiter=";")


def anon_annotation(raw):
    v = (raw or "").strip()
    if not v:
        return None
    return ANON_TEXT_PLACEHOLDER if ANONYMIZE else v


def delivery_method(m, azure_container, aws_bucket):
    if (aws_bucket or "").strip():
        return "s3"
    if (azure_container or "").strip() or (m or "").strip() == "7":
        return "adls"
    return "scp"


def load_lookups(g):
    """Name-keyed resolvers from the live product tree + country ISO by id."""
    with g.cursor() as c:
        c.execute("SELECT name, id::text FROM product WHERE kind='modality' AND name<>''")
        modality_by_name = {}
        for n, i in c.fetchall():
            modality_by_name.setdefault(n, i)
        # product name -> (product id, its modality id). Names are unique.
        c.execute("""SELECT p.name, p.id::text,
                            (SELECT m.id::text FROM product m
                             WHERE m.path = subltree(p.path, 0, 2))
                     FROM product p WHERE p.kind='product' AND p.name<>''""")
        product_by_name = {}
        for n, pid, mid in c.fetchall():
            product_by_name.setdefault(n, (pid, mid))
    # country id (region OR country id) -> ISO, from the source tables.
    iso_by_country = {r["ID"]: (r.get("CODE3166") or "").strip() for r in read("RDCOUNTRY")}
    region_iso = {}
    for r in read("RDREGION"):
        region_iso[r["ID"]] = iso_by_country.get(r.get("COUNTRYID", ""), "")
    def country_iso(cid):
        cid = (cid or "").strip()
        return (iso_by_country.get(cid) or region_iso.get(cid) or None) if cid not in ("0", "") else None
    # legacy RDPRODUCT id -> name (to resolve RDSUBSCRIPTION.PRODUCTID by name)
    prod_name = {r["ID"]: (r.get("NAME") or "").strip() for r in read("RDPRODUCT")}
    return modality_by_name, product_by_name, country_iso, prod_name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    dsn = os.environ.get("IMPORT_GLOBAL_DSN")
    if not dsn:
        sys.exit("IMPORT_GLOBAL_DSN is not set")

    g = psycopg.connect(dsn)
    modality_by_name, product_by_name, country_iso, prod_name = load_lookups(g)

    # --- subscriber_server rows (keyed by legacy id) ---
    servers = {}
    for r in read("RDSUBSCRIBER"):
        servers[r["ID"]] = {
            "name": (r.get("NAME") or "").strip(),
            "ip_address": (r.get("IPADDRESS") or "").strip() or None,
            "country": country_iso(r.get("COUNTRYID")),
            "delivery_method": delivery_method(r.get("DELIVERYMETHOD"), r.get("AZURECONTAINER"), r.get("AWSBUCKET")),
            "root_path": (r.get("DATAROOT") or "").strip() or None,
            "use_partno_folder": (r.get("TARGETDIRECTORYMODE") or "").strip() == "1",
            "container_path": (r.get("AZURECONTAINER") or "").strip() or None,
            "use_case": "compliance" if (r.get("USECASETYPE") or "").strip() == "1" else "internal",
            "activated": (r.get("ACTIVATED") or "").strip() == "1",
            "comment": anon_annotation(r.get("ANNOTATIONS")),
        }

    # --- subscription rows (keyed by legacy id) ---
    subs = {}
    missing_prod = set()
    for r in read("RDSUBSCRIPTION"):
        pid_legacy = (r.get("PRODUCTID") or "").strip()
        pname = prod_name.get(pid_legacy, "")
        mod_id = prod_id = None
        if pname in product_by_name:
            prod_id, mod_id = product_by_name[pname]
        elif pname in modality_by_name:
            mod_id = modality_by_name[pname]
        elif pid_legacy not in ("0", ""):
            missing_prod.add(pname or pid_legacy)
        tp = (r.get("TYPEPATTERN") or "").strip()
        subs[r["ID"]] = {
            "name": (r.get("NAME") or "").strip(),
            "modality_id": mod_id,
            "product_id": prod_id,
            "pattern": (r.get("NAMEPATTERN") or "").strip(),
            "negate": len(tp) > 3 and tp[3] == "1",   # bit-4 = negate (verified: 5 MR subs)
        }

    # --- attach matrix (RDSUBSCRIPTIONLIST) ---
    attach = set()
    for r in read("RDSUBSCRIPTIONLIST"):
        sid = r.get("SUBSCRIBERID"); subid = r.get("SUBSCRIPTIONID")
        if sid in servers and subid in subs:
            attach.add((sid, subid))

    print(f"parsed {len(servers)} servers, {len(subs)} subscriptions, {len(attach)} attachments "
          f"(ANONYMIZE={'on' if ANONYMIZE else 'off'})")
    if missing_prod:
        print(f"  WARN {len(missing_prod)} unresolved product/modality name(s):", ", ".join(sorted(missing_prod))[:200])
    if a.dry_run:
        print("dry-run: no writes"); g.close(); return

    with g.cursor() as c:
        # Clean rebuild (self-contained; the FK cascades subscription_server).
        c.execute("TRUNCATE subscription_server, subscription, subscriber_server RESTART IDENTITY CASCADE")
        srv_uuid = {}
        for lid, f in servers.items():
            c.execute(
                """INSERT INTO subscriber_server
                     (name, ip_address, country, use_case, comment, activated,
                      delivery_method, root_path, use_partno_folder, container_path)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (f["name"], f["ip_address"], f["country"], f["use_case"], f["comment"],
                 f["activated"], f["delivery_method"], f["root_path"],
                 f["use_partno_folder"], f["container_path"]),
            )
            srv_uuid[lid] = c.fetchone()[0]
        sub_uuid = {}
        for lid, f in subs.items():
            c.execute(
                """INSERT INTO subscription (name, modality_id, product_id, pattern, negate)
                   VALUES (%s,%s,%s,%s,%s) RETURNING id""",
                (f["name"], f["modality_id"], f["product_id"], f["pattern"], f["negate"]),
            )
            sub_uuid[lid] = c.fetchone()[0]
        n_att = 0
        for sid, subid in attach:
            c.execute("INSERT INTO subscription_server (subscription_id, server_id) "
                      "VALUES (%s,%s) ON CONFLICT DO NOTHING", (sub_uuid[subid], srv_uuid[sid]))
            n_att += c.rowcount
    g.commit()
    print(f"wrote {len(srv_uuid)} servers, {len(sub_uuid)} subscriptions, {n_att} attachments")
    g.close()


if __name__ == "__main__":
    main()
