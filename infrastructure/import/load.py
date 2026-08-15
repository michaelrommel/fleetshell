#!/usr/bin/env python3
"""load.py -- anonymizing bulk importer for the FleetShell MDM dev clusters.

Reads the gzipped semicolon CSV exports in old_database/, transforms + anonymizes
them (see docs/data_import.md and anonymize.py), and COPYs into the two Aurora
clusters. Referential integrity across files is kept via per-run IdMaps, which
are DESTROYED at the end unless --keep is given.

Connections (env):
  IMPORT_GLOBAL_DSN  e.g. "host=localhost port=5432 dbname=fleetshell       user=fsadmin password=... sslmode=require"
  IMPORT_LOCAL_DSN   e.g. "host=localhost port=5433 dbname=fleetshell_local user=fsadmin password=... sslmode=require"

Usage:
  python load.py --stage all                 # full run
  python load.py --stage reference           # regions/products/gateways only
  python load.py --stage devices --limit 5000  # quick dry slice
Stages run in order: reference, devices, users, grants.
"""

from __future__ import annotations
import argparse, csv, gzip, json, os, sys, uuid
import psycopg
from anonymize import IdMap, LabelMap, fake_person, fake_email, fake_serial, \
    hospital_generator, company_generator, site_generator, city_generator, \
    functional_location_generator, ip_generator, technical_ident_generator, \
    hostid_generator, orderno_generator, contact_generator, public_ip_generator

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "old_database")

def src(name): return os.path.join(SRC, name + ".csv.gz")

def read(name):
    """Yield dict rows from a gzipped ;-CSV (UTF-8, CRLF, quoted multiline)."""
    with gzip.open(src(name), "rt", encoding="utf-8", newline="") as f:
        yield from csv.DictReader(f, delimiter=";")

# --- id / label maps (shared across stages; destroyed at end) ----------------
user_map    = IdMap(os.path.join(HERE, "user.map.json"))
group_map   = IdMap(os.path.join(HERE, "group.map.json"))
device_map  = IdMap(os.path.join(HERE, "device.map.json"))
gateway_map = IdMap(os.path.join(HERE, "gateway.map.json"))
product_map = IdMap(os.path.join(HERE, "product.map.json"))
model_map   = IdMap(os.path.join(HERE, "model.map.json"))
customer_map= IdMap(os.path.join(HERE, "customer.map.json"))
site_map    = IdMap(os.path.join(HERE, "site.map.json"))
hospital_lbl= LabelMap(os.path.join(HERE, "hospital.map.json"), hospital_generator())
customer_lbl= LabelMap(os.path.join(HERE, "customer_lbl.map.json"), company_generator())
site_lbl    = LabelMap(os.path.join(HERE, "site_lbl.map.json"), site_generator())
fl_lbl      = LabelMap(os.path.join(HERE, "fl.map.json"),        functional_location_generator())
ip_lbl      = LabelMap(os.path.join(HERE, "ip.map.json"),        ip_generator())
tid_lbl     = LabelMap(os.path.join(HERE, "tid.map.json"),       technical_ident_generator())
host_lbl    = LabelMap(os.path.join(HERE, "host.map.json"),      hostid_generator())
ord_lbl     = LabelMap(os.path.join(HERE, "ord.map.json"),       orderno_generator())
contact_lbl = LabelMap(os.path.join(HERE, "contact.map.json"),   contact_generator())
city_lbl    = LabelMap(os.path.join(HERE, "city.map.json"),      city_generator())
pubip_gen   = public_ip_generator()   # synthesized per gateway (no real value to map)

ALL_MAPS = [user_map, group_map, device_map, gateway_map, product_map, model_map, customer_map, site_map,
            hospital_lbl, customer_lbl, site_lbl, fl_lbl, ip_lbl, tid_lbl, host_lbl, ord_lbl, contact_lbl, city_lbl]

# --- role name -> (resource_type, verb) list ---------------------------------
CRUD_DEVICE = [("device","view"),("device","connect"),("device","edit"),("device","delete")]
CRUD_REGION = [("region","view"),("region","create"),("region","edit"),("region","delete")]
CRUD_GROUP  = [("group","view"),("group","create"),("group","edit"),("group","delete"),
               ("group","add_member"),("group","remove_member")]
CRUD_PRODUCT= [("product","maintain"),("product","create"),("product","edit"),("product","delete")]
ALL_TYPES   = CRUD_DEVICE+CRUD_REGION+CRUD_GROUP+CRUD_PRODUCT+[("customer","create"),
              ("site","create"),("site","edit"),("grant","create"),("grant","view")]

ROLE_PRIVS = {
    "User": [("device","view"),("device","connect")],
    "Connect under constr. systems": [("device","view"),("device","connect")],
    "CWP User": [("device","view")],
    "ReadOnly": [("device","view")],
    "Helpdesk Support Role": CRUD_DEVICE,
    "SRSConfiguration": CRUD_DEVICE,
    "SRS Manager": CRUD_REGION,
    "CountryKeyUserAdmin": CRUD_REGION,
    "CountryUserAdmin": CRUD_REGION,
    "GroupManager": CRUD_GROUP,
    "GroupAdmin": CRUD_GROUP,
    "GroupUserAdmin": [("group","add_member"),("group","remove_member")],
    "UserGroupView": [("group","view")],
    "BURepresentative": CRUD_PRODUCT,
    "SuperUser": ALL_TYPES,
}
DEFAULT_PRIVS = [("device","view"),("device","connect")]

# in-memory lookups filled during reference stage
region_path: dict[str,str] = {}      # RDREGION.ID -> id-based ltree
region_iso:  dict[str,str] = {}      # RDREGION.ID -> ISO (country ancestor)
admin_region_ids: set[str] = set()   # RDREGION.ID of REGIONTYPE=1 (administrative regions, dropped)
product_path: dict[str,str] = {}     # RDPRODUCT.ID -> id-based ltree
product_modality: dict[str,str] = {} # RDPRODUCT.ID -> top-level category name
product_model_path: dict[str,str] = {} # RDPRODUCTMODEL.ID -> model node ltree
gateway_src_ids: set = set()         # RSROUTER ids that actually got a gateway row


def chain_path(node_id, parent_of, sep="."):
    """Build an id-based ltree path by walking parents to the root."""
    parts = []
    seen = set()
    cur = node_id
    while cur and cur not in seen and cur in parent_of:
        seen.add(cur)
        parts.append(cur)
        cur = parent_of[cur]
    if cur and cur not in parts:
        parts.append(cur)
    return sep.join(reversed(parts))


# =============================================================================
# STAGE: reference (region, product, gateway, and their in-memory maps)
# =============================================================================
def stage_reference(g: psycopg.Connection, emit: bool = True):
    # Always builds the in-memory lookups (region_path/product_path/modality) so
    # that a standalone --stage devices/grants run still resolves them; only
    # COPYs the reference tables when emit=True.
    # --- countries (ISO by countryid) ---
    iso_by_country = {r["ID"]: r["CODE3166"].strip() for r in read("RDCOUNTRY")}

    # --- region nodes: World > Country > State, straight from RDREGION ---
    # (RDCOUNTRY2DMZ/RDDMZ is a VPN routing table, not geography, so we do NOT
    #  synthesize a continent layer from it. A business-region level can be
    #  added later from an explicit ISO -> SH-region mapping if wanted.)
    #
    # REGIONTYPE=1 nodes are NOT geography: they are the legacy "administrative
    # regions" (_A_BU_AX, _old_RSC_*, 'Administrative Region 1', ...) that only
    # existed to give group/delegation grants a region-shaped scope in the old
    # authz model. Our model scopes those natively by resource_type='group', so
    # these placeholders are dead weight: 0 devices live in them and they only
    # pollute the Region Tree (they sit at level 2, masquerading as countries).
    # We drop them here and skip any grant scoped to them in stage_grants.
    regions = [r for r in read("RDREGION") if (r.get("REGIONTYPE") or "0") != "1"]
    admin_region_ids.update(
        r["ID"] for r in read("RDREGION") if (r.get("REGIONTYPE") or "0") == "1")
    parent_of = {r["ID"]: (None if r["ID"] == "1" else (r["PARENTID"] or None)) for r in regions}
    walk = {k: v for k, v in parent_of.items() if v}

    rows = []
    for r in regions:
        rid, cid = r["ID"], r["COUNTRYID"]
        p = chain_path(rid, walk) or rid
        region_path[rid] = p
        region_iso[rid] = iso_by_country.get(cid, "")
        rows.append((int(rid), p, r["NAME"] or rid, iso_by_country.get(cid) or None,
                     p.count(".") + 1, int(parent_of[rid]) if parent_of.get(rid) else None))
    copy_rows(g, "region (id,path,name,iso,level,parent_id)", rows, on_conflict="id") if emit else None
    if emit: print(f"  region: {len(rows)} (skipped {len(admin_region_ids)} administrative)")

    # --- products (id-based path + top-level modality) ---
    prods = list(read("RDPRODUCT"))
    pparent = {p["ID"]: p["PARENTID"] for p in prods}
    pname   = {p["ID"]: p["NAME"].strip() for p in prods}
    prows = []
    for p in prods:
        pid = p["ID"]
        path = chain_path(pid, {k: v for k, v in pparent.items() if v and v != "0"})
        if not path:
            path = pid
        product_path[pid] = path
        # modality = the level-2 ancestor's name (child of root)
        labels = path.split(".")
        top = labels[1] if len(labels) > 1 else labels[0]
        product_modality[pid] = (pname.get(top) or "").strip()
        # kind by tree depth: root/modality <= L2, product = L3 (models are L4,
        # loaded from RDPRODUCTMODEL below). Mirrors migrate_product_model.sql.
        depth = len(labels)
        kind = "modality" if depth <= 2 else "product"
        prows.append((product_map.get(pid), path, kind, None, pname.get(pid) or ""))
    if emit:
        copy_rows(g, "product (id,path,kind,family,name)", prows, on_conflict="id")
        print(f"  product: {len(prows)}")

    # --- product models (the leaf level below products) ---
    # RDPRODUCTMODEL carries the rich per-model master data the old importer
    # never moved: partno, integer serial range, host-computer flag. Each model
    # becomes a kind='model' product node (child of its RDPRODUCT product, so
    # nlevel 4) plus a 1:1 product_model satellite row. Names are catalog data
    # (not PII), kept as-is. Serial ranges stay REAL (they are catalog bounds);
    # note that device serials are faked, so demo devices won't fall in range.
    def _int(s):
        s = (s or "").strip()
        return int(s) if s.isdigit() else None
    mnodes, msat = [], []
    for m in read("RDPRODUCTMODEL"):
        mid, ppid = m["ID"], m["PRODUCTID"]
        base = product_path.get(ppid)
        if not base:
            continue                       # orphan model -> skip
        node = model_map.get(mid)
        mpath = f"{base}.{mid}"
        product_model_path[mid] = mpath
        mnodes.append((node, mpath, "model", None, (m["NAME"] or "").strip()))
        msat.append((node, _int(m["PARTNUMBER"]), _int(m["SERIALFROM"]),
                     _int(m["SERIALTO"]), (m["SYSTEMHOST"] or "").strip() == "1"))
    if emit:
        copy_rows(g, "product (id,path,kind,family,name)", mnodes, on_conflict="id")
        copy_rows(g, "product_model (product_id,partno,serial_from,serial_to,is_host_computer)",
                  msat, on_conflict="product_id")
        print(f"  product_model: {len(mnodes)}")

    # --- gateways (RS routers = communication interfaces) from the detail view ---
    # Enriched per the Gateways page: router NAME (id / cisco serial) kept RAW;
    # IDENTIFIER2 (customer/hospital) shares the device hospital map so the same
    # real name anonymizes identically on device + gateway; IDENTIFIER1 (city)
    # and admin IPs anonymized (IPs via the shared device IP map). SITENAME is
    # 'none' everywhere -> skipped. Enum/code + type fields kept raw for now;
    # drop unwanted columns once the data is visible in the UI.
    def an(m, raw):
        v = (raw or "").strip()
        return m.get(v) if v else None
    def raw(v):
        v = (v or "").strip()
        return v or None
    # Decode the code fields to their user-readable labels (fallback: raw code).
    CONN_LABELS = {"5": "Internet with IPSec", "20": "Internet with IPSec (DMVPN)"}
    OPSTATE_LABELS = {"55": "Access Allowed", "21": "Access Denied"}
    def decode(m, v):
        v = (v or "").strip()
        return m.get(v, v or None) if v else None
    def gwmodel(v):
        v = (v or "").strip()
        return None if v in ("", "undefined") else v
    grows = []
    for r in read("RDRSROUTERDETAILVIEWV1"):
        gid = gateway_map.get(r["ID"])
        gateway_src_ids.add(r["ID"])
        # NOTE: hostname (DynDNS) is left NULL -- authored in the UI for dynamic-IP
        # gateways. In production it, plus the DynDNS password (WEBDNSPWID /
        # WEBDNSPWPW in the source), would feed the IPsec dyndns config.
        grows.append((
            gid, r.get("REGIONNAME") or "",
            hospital_lbl.get(r.get("IDENTIFIER2") or r["ID"]),   # hospital = anon customer/hospital (shared map)
            raw(r.get("NAME")),                 # name (router id / cisco serial) RAW
            an(city_lbl, r.get("IDENTIFIER1")), # city (anon)
            gwmodel(r.get("DISPLAYROUTERTYPE")),          # gateway_model ('undefined' -> NULL)
            decode(CONN_LABELS, r.get("CONNECTIONTYPE")),      # connection_type (decoded)
            decode(OPSTATE_LABELS, r.get("OPERATIONALSTATE")), # operational_state (decoded)
            raw(r.get("STATICIP")),             # static_ip RAW
            raw(r.get("NATTYPE")),              # nat_type RAW
            an(ip_lbl, r.get("IPADDRESSADM1")), # admin_ip (anon)
            an(ip_lbl, r.get("IPADDRESSADM2")), # admin_ip2 (anon)
            raw(r.get("COUNTRYNAME")),          # country RAW
            pubip_gen(),                        # public_ip (synthesized tunnel endpoint)
        ))
    if emit:
        copy_rows(g, "gateway (id,region,hospital,name,city,gateway_model,connection_type,"
                     "operational_state,static_ip,nat_type,admin_ip,admin_ip2,country,public_ip)",
                  grows, on_conflict="id")
        print(f"  gateway: {len(grows)}")


# =============================================================================
# STAGE: devices
# =============================================================================
def stage_devices(g: psycopg.Connection, limit: int | None):
    cust_rows, site_rows, seen_cust, seen_site = [], [], set(), set()
    def ensure_customer(key, iso, requires=False):
        u = customer_map.get(key)
        if key not in seen_cust:
            seen_cust.add(key)
            cust_rows.append((u, iso or "", customer_lbl.get(key), requires))
        return u
    def cust_uuid(cid, iso):
        if cid in ("0","1",""): return None
        return ensure_customer("C"+cid, iso)
    def site_uuid(sid, cust_u, iso, requires):
        if sid in ("0","1",""): return None
        if cust_u is None:
            cust_u = ensure_customer("SC"+sid, iso)   # orphan site -> synthetic customer
        u = site_map.get(sid)
        if sid not in seen_site:
            seen_site.add(sid)
            site_rows.append((u, cust_u, iso or "", site_lbl.get("S"+sid), requires, "dynamic"))
        return u

    drows = []
    n = 0
    for r in read("RDSERVICEDSYSTEM"):
        n += 1
        if limit and n > limit: break
        did = device_map.get(r["ID"])
        rid = r["REGIONID"]
        pid = r["PRODUCTID"]
        pmid = (r.get("PRODUCTMODELID") or "").strip()
        iso = region_iso.get(rid) or None
        exp, esite = r["EXPLICITAUTHEXP"], r["EXPLICITAUTHSITE"]
        access = "device" if exp == "1" else ("site" if esite == "1" else "open")
        cust_u = cust_uuid(r.get("CUSTOMERID",""), iso)
        site_u = site_uuid(r.get("CUSTOMERSITEID",""), cust_u, iso, access == "site")

        # Anonymize a source field via a stable LabelMap; empty -> NULL.
        def an(m, raw):
            v = (raw or "").strip()
            return m.get(v) if v else None

        drows.append((
            did,
            region_path.get(rid),
            iso,
            (product_modality.get(pid) or None),
            product_model_path.get(pmid) or product_path.get(pid),   # re-point to the MODEL node
            cust_u,
            site_u,
            gateway_map.get(r["RSROUTERID"]) if r.get("RSROUTERID") in gateway_src_ids else None,
            hospital_lbl.get(r.get("HOSPITAL") or r["ID"]),
            None,                                   # software_version unknown in export
            access,
            psycopg.types.json.Json({}),
            fake_serial(),                          # serial (SERIAL)
            an(fl_lbl,   r.get("IDENTIFIER3")),     # functional_location
            an(tid_lbl,  r.get("SYSTEMID2")),       # technical_ident
            an(host_lbl, r.get("HOSTID")),          # host_hw_id
            an(ord_lbl,  r.get("ORDERNO")),         # order_number
            an(ip_lbl,   r.get("IPADDRESS1")),      # ip_address
            an(ip_lbl,   r.get("REALIPADDRESS")),   # ip_real (same map -> same fake per real ip)
            an(contact_lbl, r.get("CONTACT")),      # contact (PII)
            an(city_lbl, r.get("CITY")),            # city (anon; shared map with gateway city)
        ))
        if len(drows) >= 10000:
            _flush_devices(g, drows, cust_rows, site_rows); drows.clear()
    _flush_devices(g, drows, cust_rows, site_rows)
    print(f"  devices: {n if not limit else min(n,limit)}  customers:{len(seen_cust)} sites:{len(seen_site)}")


def _flush_devices(g, drows, cust_rows, site_rows):
    if cust_rows:
        copy_rows(g, "customer (id,country,name,requires_explicit_grant)", cust_rows, on_conflict="id"); cust_rows.clear()
    if site_rows:
        copy_rows(g, "customer_site (id,customer_id,country,name,requires_explicit_grant,membership_kind)", site_rows, on_conflict="id"); site_rows.clear()
    if drows:
        copy_rows(g, "device (id,region_path,country_iso,modality,product_path,customer_id,"
                     "site_id,gateway_id,hospital_name,software_version,access_requirement,attrs,"
                     "serial,functional_location,technical_ident,host_hw_id,order_number,"
                     "ip_address,ip_real,contact,city)", drows, on_conflict="id")


# =============================================================================
# STAGE: users (LOCAL plane)
# =============================================================================
def stage_users(l: psycopg.Connection, limit: int | None):
    # RDUSER.COUNTRYID -> ISO (RDCOUNTRY.CODE3166): the persona's country, needed
    # by the Data Transfer Matrix. 7733/7735 personas resolve. Built here so a
    # standalone `--stage users` run does not depend on stage_reference.
    iso_by_country = {r["ID"]: (r["CODE3166"] or "").strip() for r in read("RDCOUNTRY")}
    rows = []
    n = have = 0
    for r in read("RDUSER"):
        n += 1
        if limit and n > limit: break
        uid = user_map.get(r["ID"])
        fn, ln = fake_person()
        cid = (r.get("COUNTRYID") or "").strip()
        country = iso_by_country.get(cid) or None if cid not in ("0", "") else None
        if country: have += 1
        rows.append((uid, "eu-west-2", fn, ln, fake_email(n), None, country))
    copy_rows(l, "app_user (user_id,home_region,firstname,lastname,email,theme,country)", rows, on_conflict="user_id")
    print(f"  users: {len(rows)} ({have} with country)")


# =============================================================================
# STAGE: grants  (-> groups, memberships, roles, scopes, grants)
# =============================================================================
def stage_grants(g: psycopg.Connection, l: psycopg.Connection, limit: int | None):
    # Device IDENTIFIER1 -> RDSERVICEDSYSTEM.ID, for single-system (per-device)
    # grants: those grant rows carry the device serial in FUNCTIONALLOCATION and
    # no region/product/customer/site. 100% resolve via IDENTIFIER1.
    ident1_to_sysid: dict[str, str] = {}
    for r in read("RDSERVICEDSYSTEM"):
        ident = (r.get("IDENTIFIER1") or "").strip()
        if ident:
            ident1_to_sysid[ident] = r["ID"]

    role_cache: dict[str,str] = {}          # rolename -> role uuid
    role_priv_rows = []
    def role_uuid(name):
        if name not in role_cache:
            u = str(uuid.uuid4()); role_cache[name] = u
            for (rt, vb) in ROLE_PRIVS.get(name, DEFAULT_PRIVS):
                role_priv_rows.append((u, rt, vb))
        return role_cache[name]

    scope_cache: dict[tuple,str] = {}
    scope_rows, constraint_rows, scope_device_rows = [], [], []
    def scope_uuid(region_p, product_p, cust_u, site_u):
        key = (region_p, product_p, cust_u, site_u)
        if key not in scope_cache:
            u = str(uuid.uuid4()); scope_cache[key] = u
            scope_rows.append((u, "device", "attribute", ""))
            if region_p:  constraint_rows.append((u, "region_path", "subtree", "{"+region_p+"}"))
            if product_p: constraint_rows.append((u, "product_path", "subtree", "{"+product_p+"}"))
            if cust_u:    constraint_rows.append((u, "customer_id", "in", "{"+cust_u+"}"))
            if site_u:    constraint_rows.append((u, "site_id", "in", "{"+site_u+"}"))
        return scope_cache[key]

    def single_scope_uuid(device_u, label):
        # A single_system scope naming exactly one device (shared across groups).
        key = ("single", device_u)
        if key not in scope_cache:
            u = str(uuid.uuid4()); scope_cache[key] = u
            scope_rows.append((u, "device", "single_system", label[:60]))
            scope_device_rows.append((u, device_u))
        return scope_cache[key]

    group_rows, seen_groups = [], set()
    def group_uuid(gid, gname):
        u = group_map.get(gid if gid not in ("0","") else "u"+gname)
        if u not in seen_groups:
            seen_groups.add(u)
            label = gname or "grantee"
            group_rows.append((u, "eu-west-2", label[:120], "g"+u.replace("-","")[:30], None))
        return u

    grant_rows, seen_grants = [], set()
    member_rows, seen_members = [], set()
    n = kept = skipped_admin = 0
    for r in read("RDGRANTVIEWV1"):
        n += 1
        if limit and n > limit: break
        if r["DOMAINNAME"]:                         # GRANTTYPE 3275 domain grants -> skip
            continue
        # Grants scoped to an administrative region (REGIONTYPE=1) authorize
        # nothing in our model: 0 devices live there, so the scope matches the
        # empty set today. Drop the WHOLE grant row -- never just null the region
        # dimension, which would widen it from "matches nothing" to a product/
        # customer/site wildcard. Effective authorization is unchanged.
        if r["REGIONID"] in admin_region_ids:
            skipped_admin += 1
            continue
        gid = r["GROUPID"]
        grp = group_uuid(gid, r["GROUPNAME"] or ("user:"+r["GRANTEEID"]))
        # membership: grantee user -> group
        gu = user_map.get(r["GRANTEEID"]) if r["GRANTEEID"] not in ("0","") else None
        if gu and (grp, gu) not in seen_members:
            seen_members.add((grp, gu)); member_rows.append((grp, gu))
        # scope from region/product/customer/site (ANY / 0 / 1 = wildcard)
        region_p  = region_path.get(r["REGIONID"]) if r["REGIONID"] not in ("0","") else None
        product_p = product_path.get(r["PRODUCTID"]) if r["PRODUCTNAME"] not in ("ANY","","") and r["PRODUCTID"] not in ("0","1","") else None
        cust_u = customer_map.get("C"+r["CUSTOMERID"]) if r["CUSTOMERID"] not in ("0","1","") else None
        site_u = site_map.get(r["SITEID"]) if r["SITEID"] not in ("0","1","") else None
        if any((region_p, product_p, cust_u, site_u)):
            sc = scope_uuid(region_p, product_p, cust_u, site_u)
        else:
            # Single-system (per-device) grant: the item is a device serial in
            # FUNCTIONALLOCATION. Resolve IDENTIFIER1 -> device -> single_system.
            fl = (r["FUNCTIONALLOCATION"] or "").strip()
            sysid = ident1_to_sysid.get(fl) if fl and fl != "-" else None
            if not sysid or not device_map.has(sysid):
                continue                             # unknown/absent device -> skip
            sc = single_scope_uuid(device_map.get(sysid), fl)
        rl = role_uuid(r["ROLENAME"] or "User")
        key = (grp, rl, sc)
        if key in seen_grants:
            continue
        seen_grants.add(key)
        grant_rows.append((str(uuid.uuid4()), grp, rl, sc)); kept += 1
        if len(grant_rows) >= 20000:
            _flush_grants(g, group_rows, role_cache, role_priv_rows, scope_rows,
                          constraint_rows, scope_device_rows, grant_rows)
            group_rows.clear(); role_priv_rows.clear(); scope_rows.clear()
            constraint_rows.clear(); scope_device_rows.clear(); grant_rows.clear()
    _flush_grants(g, group_rows, role_cache, role_priv_rows, scope_rows,
                  constraint_rows, scope_device_rows, grant_rows)
    # memberships -> LOCAL plane
    copy_rows(l, "group_membership (group_id,user_id)", member_rows, on_conflict="group_id,user_id")
    singles = sum(1 for k in scope_cache if isinstance(k, tuple) and len(k) == 2 and k[0] == "single")
    print(f"  grants: scanned {n}, kept {kept}, skipped {skipped_admin} administrative-region, "
          f"groups {len(seen_groups)}, "
          f"scopes {len(scope_cache)} (single-system {singles}), roles {len(role_cache)}, members {len(member_rows)}")


def _flush_grants(g, group_rows, role_cache, role_priv_rows, scope_rows, constraint_rows, scope_device_rows, grant_rows):
    if group_rows:
        copy_rows(g, "principal_group (group_id,home_region,label,path,parent_id)", group_rows, on_conflict="group_id")
    if role_cache:
        copy_rows(g, "authz_role (id,key,name)",
                  [(u, name[:60]+"-"+u[:8], name[:120]) for name, u in role_cache.items()],
                  on_conflict="id")
    if role_priv_rows:
        # resolve (resource_type,verb) -> privilege id at insert time
        with g.cursor() as c:
            c.executemany(
                "INSERT INTO authz_role_privilege(role_id,privilege_id) "
                "SELECT %s, id FROM authz_privilege WHERE resource_type=%s AND verb=%s "
                "ON CONFLICT DO NOTHING", role_priv_rows)
    if scope_rows:
        copy_rows(g, "authz_scope (id,resource_type,kind,label)", scope_rows, on_conflict="id")
    if constraint_rows:
        copy_rows(g, "authz_scope_constraint (scope_id,dimension,op,values)", constraint_rows)
    if scope_device_rows:
        copy_rows(g, "authz_scope_device (scope_id,device_id)", scope_device_rows,
                  on_conflict="scope_id,device_id")
    if grant_rows:
        copy_rows(g, "authz_grant (id,group_id,role_id,scope_id)", grant_rows, on_conflict="id")


# =============================================================================
# COPY helper (via a temp staging table when ON CONFLICT is needed)
# =============================================================================
def copy_rows(conn, target, rows, on_conflict=None):
    if not rows:
        return
    cols = target[target.index("(")+1:target.rindex(")")]
    table = target[:target.index("(")].strip()
    with conn.cursor() as c:
        if on_conflict:
            c.execute(f"CREATE TEMP TABLE _stg (LIKE {table} INCLUDING DEFAULTS) ON COMMIT DROP")
            with c.copy(f"COPY _stg ({cols}) FROM STDIN") as cp:
                for row in rows: cp.write_row(row)
            c.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM _stg "
                      f"ON CONFLICT ({on_conflict}) DO NOTHING")
            c.execute("DROP TABLE _stg")
        else:
            with c.copy(f"COPY {table} ({cols}) FROM STDIN") as cp:
                for row in rows: cp.write_row(row)
    conn.commit()


def ensure_privileges(g):
    with g.cursor() as c:
        for (rt, vb) in set(ALL_TYPES):
            c.execute("INSERT INTO authz_resource_type(key,description) VALUES(%s,'') ON CONFLICT DO NOTHING", (rt,))
            c.execute("INSERT INTO authz_privilege(resource_type,verb) VALUES(%s,%s) ON CONFLICT DO NOTHING", (rt, vb))
    g.commit()


# ---------------------------------------------------------------------------
# STAGE: product families (populate product.family by NAME, reload-survivable)
# ---------------------------------------------------------------------------
def stage_families(g: psycopg.Connection, path: str | None = None):
    """Populate product.family from the committed product_families.json
    (family -> product names, keyed by NAME so it survives a reload). Per
    modality: reset family to NULL for that modality's products, then set it for
    the listed products ('*' = every product in the modality). The family strings
    MUST match the classification sheet's family column so the dormant family
    assignments resolve. See docs/data_classification.md."""
    path = path or os.path.join(HERE, "product_families.json")
    if not os.path.exists(path):
        print(f"  families: {path} absent -- skipped")
        return
    with open(path) as f:
        fam = json.load(f)
    with g.cursor() as c:
        for modality, groups in fam.items():
            if modality.startswith("_"):
                continue  # comment keys
            c.execute("SELECT id, path::text FROM product WHERE kind='modality' AND name=%s", (modality,))
            row = c.fetchone()
            if not row:
                print(f"  families {modality}: modality node not found -- skipped")
                continue
            mod_id, mod_path = row
            c.execute("SELECT name, id FROM product WHERE kind='product' AND path <@ %s::ltree", (mod_path,))
            prod_by_name = {}
            for nm, pid in c.fetchall():
                prod_by_name.setdefault(nm, pid)
            # reset, then apply (file = source of truth for this modality).
            # Wildcards first (modality default), then explicit lists so a named
            # product always overrides the wildcard (e.g. the security appliance
            # is its own family, not the modality-wide Numaris/Somaris default).
            c.execute("UPDATE product SET family=NULL WHERE kind='product' AND path <@ %s::ltree", (mod_path,))
            unmatched = set()
            for family, names in groups.items():
                if names == ["*"] or names == "*":
                    c.execute("UPDATE product SET family=%s WHERE kind='product' AND path <@ %s::ltree",
                              (family, mod_path))
            for family, names in groups.items():
                if names == ["*"] or names == "*":
                    continue
                for nm in names:
                    pid = prod_by_name.get(nm)
                    if pid is None:
                        unmatched.add(nm); continue
                    c.execute("UPDATE product SET family=%s WHERE id=%s", (family, pid))
            c.execute("SELECT count(*) FROM product WHERE kind='product' AND family IS NOT NULL AND path <@ %s::ltree",
                      (mod_path,))
            n_set = c.fetchone()[0]
            msg = f"  families {modality:5}: {n_set} product(s) tagged"
            if unmatched:
                msg += f", {len(unmatched)} UNMATCHED"
            print(msg)
            for u in sorted(unmatched):
                print(f"      unmatched product name: {u}")
    g.commit()


# ---------------------------------------------------------------------------
# STAGE: data classification (re-apply the committed, name-keyed artifact)
# ---------------------------------------------------------------------------
def stage_classification(g: psycopg.Connection, path: str | None = None):
    """Re-apply classification.json by product/family NAME (never UUID), so a
    full old_database reload cannot orphan it. Per-modality wipe-and-reload; the
    committed artifact is the source of truth (round-trip via
    classification_export.py). See docs/data_classification.md."""
    path = path or os.path.join(HERE, "classification.json")
    if not os.path.exists(path):
        print(f"  classification: {path} absent -- skipped")
        return
    with open(path) as f:
        art = json.load(f)
    with g.cursor() as c:
        for modality, block in art.get("modalities", {}).items():
            c.execute("SELECT id, path::text FROM product WHERE kind='modality' AND name=%s", (modality,))
            row = c.fetchone()
            if not row:
                print(f"  classification {modality}: modality node not found -- skipped")
                continue
            mod_id, mod_path = row
            c.execute("SELECT name, id FROM product WHERE kind='product' AND path <@ %s::ltree", (mod_path,))
            prod_by_name = {}
            for nm, pid in c.fetchall():
                prod_by_name.setdefault(nm, pid)   # first wins if names collide
            # wipe existing classification for this modality (cascades)
            c.execute("DELETE FROM classification_set WHERE modality_id=%s", (mod_id,))
            n_sets = n_rules = n_assign = 0
            unmatched = set()
            for s in block.get("sets", []):
                c.execute("INSERT INTO classification_set(modality_id,name,description) "
                          "VALUES(%s,%s,%s) RETURNING id",
                          (mod_id, s["name"], s.get("description") or None))
                set_id = c.fetchone()[0]; n_sets += 1
                for i, r in enumerate(s.get("rules", [])):
                    c.execute("INSERT INTO classification_rule(set_id,regex,sort_order) "
                              "VALUES(%s,%s,%s) RETURNING id", (set_id, r["regex"], i))
                    rid = c.fetchone()[0]; n_rules += 1
                    for code in dict.fromkeys(r.get("codes", [])):
                        c.execute("INSERT INTO classification_rule_class(rule_id,code) "
                                  "VALUES(%s,%s) ON CONFLICT DO NOTHING", (rid, code))
                a = s.get("assign", {})
                if a.get("modality_wide"):
                    c.execute("INSERT INTO classification_assignment(set_id,product_id,family) "
                              "VALUES(%s,NULL,NULL)", (set_id,)); n_assign += 1
                for fam in a.get("families", []):
                    c.execute("INSERT INTO classification_assignment(set_id,product_id,family) "
                              "VALUES(%s,NULL,%s)", (set_id, fam)); n_assign += 1
                for pname in a.get("products", []):
                    pid = prod_by_name.get(pname)
                    if pid is None:
                        unmatched.add(pname); continue
                    c.execute("INSERT INTO classification_assignment(set_id,product_id,family) "
                              "VALUES(%s,%s,NULL)", (set_id, pid)); n_assign += 1
            msg = f"  classification {modality:5}: {n_sets} sets, {n_rules} rules, {n_assign} assignments"
            if unmatched:
                msg += f", {len(unmatched)} UNMATCHED product(s)"
            print(msg)
            for u in sorted(unmatched):
                print(f"      unmatched product name: {u}")
    g.commit()


# =============================================================================
# STAGE: data transfer matrix (re-apply the committed, ISO-keyed artifact)
# =============================================================================
def stage_dtm(g: psycopg.Connection, path: str | None = None):
    """Re-apply dtm.json by FROM-ISO / variant / TO-ISO / class code (never DB
    UUIDs), so a full reload and Country-Manager UI edits both survive. Denial-
    list model: only denied tuples are stored; absence => permitted. See
    docs/data_transfer_matrix.md and dtm_dedup.py."""
    path = path or os.path.join(HERE, "dtm.json")
    if not os.path.exists(path):
        print(f"  dtm: {path} absent -- skipped"); return
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    variants = doc.get("variants", {})
    matrices = doc.get("matrices", {})
    with g.cursor() as c:
        for code, label in variants.items():
            c.execute("INSERT INTO dtm_variant(code,label) VALUES(%s,%s) "
                      "ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label", (code, label))
        n_matrix = n_deny = 0
        for from_iso, byvar in sorted(matrices.items()):
            for variant, block in sorted(byvar.items()):
                # Rebuild this FROM x variant from scratch (dtm_deny cascades).
                c.execute("DELETE FROM dtm_matrix WHERE from_iso=%s AND variant=%s", (from_iso, variant))
                c.execute("INSERT INTO dtm_matrix(from_iso,variant,default_decision) VALUES(%s,%s,%s)",
                          (from_iso, variant, block.get("default", "permit")))
                n_matrix += 1
                for to_iso, codes in block.get("deny", {}).items():
                    for code in dict.fromkeys(codes):
                        c.execute("INSERT INTO dtm_deny(from_iso,to_iso,variant,class_code) "
                                  "VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                                  (from_iso, to_iso, variant, code))
                        n_deny += 1
        print(f"  dtm: {len(matrices)} FROM-countries, {n_matrix} matrices, {n_deny} denied cells")
    g.commit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all","reference","devices","users","grants","families","classification","dtm"])
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--keep", action="store_true", help="keep the id maps (do not destroy)")
    a = ap.parse_args()

    gdsn = os.environ["IMPORT_GLOBAL_DSN"]; ldsn = os.environ["IMPORT_LOCAL_DSN"]
    g = psycopg.connect(gdsn); l = psycopg.connect(ldsn)
    ensure_privileges(g)

    # Reference tables are small and idempotent (stable ids + ON CONFLICT); load
    # them for any stage that needs them so devices/grants always find their FKs.
    if a.stage in ("all", "reference", "devices", "grants"):
        print("reference:")
        stage_reference(g, emit=True)
    if a.stage in ("all","devices"):
        print("devices:");   stage_devices(g, a.limit)
    if a.stage in ("all","users"):
        print("users:");     stage_users(l, a.limit)
    if a.stage in ("all","grants"):
        print("grants:");    stage_grants(g, l, a.limit)
    if a.stage in ("all","reference","families"):
        print("families:"); stage_families(g)
    if a.stage in ("all","reference","classification"):
        print("classification:"); stage_classification(g)
    if a.stage in ("all","dtm"):
        print("dtm:"); stage_dtm(g)

    for m in ALL_MAPS: m.save()
    with g.cursor() as c:
        c.execute("ANALYZE region; ANALYZE product; ANALYZE gateway; ANALYZE device;"
                  "ANALYZE principal_group; ANALYZE authz_grant; ANALYZE authz_scope;"
                  "ANALYZE authz_scope_constraint; ANALYZE authz_scope_device;")
    g.commit()
    with l.cursor() as c:
        c.execute("ANALYZE app_user; ANALYZE group_membership;")
    l.commit()
    g.close(); l.close()

    if not a.keep and a.stage == "all":
        for m in ALL_MAPS: m.destroy()
        print("id maps destroyed (import is now irreversible)")
    else:
        print("id maps kept (rerun-friendly). Delete *.map.json when done.")


if __name__ == "__main__":
    main()
