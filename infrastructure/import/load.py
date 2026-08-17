#!/usr/bin/env python3
"""load.py -- anonymizing bulk importer for the FleetShell MDM dev clusters.

Reads the gzipped semicolon CSV exports and COPYs them into the two Aurora
clusters, anonymizing by default. Referential integrity across files is kept via
per-run IdMaps, DESTROYED at the end unless --keep is given.

Source: the NORMALIZED second export (old_database/second_load/*.csv.gz) is
preferred; the first export (old_database/first_load/) is a fallback only for the
denormalized gateway view RDRSROUTERDETAILVIEWV1 (until the gateway stage is
migrated to RDRSROUTER). See docs/second_load_analysis.md.

Stages: reference (+customers), devices, users, roles, grants, families,
classification, dtm. Roles/privileges come from RDROLE/RDPRIVILEGE/
RDPRIVILEGE2ROLE; grants from the normalized RDBASEGRANT/RDGROUPGRANT (with the
group tree from RDUSERGROUP -- build_group_hierarchy.py is retired).
"""

from __future__ import annotations
import argparse, csv, gzip, json, os, sys, uuid
import psycopg
from anonymize import IdMap, LabelMap, fake_person, fake_email, fake_serial, \
    hospital_generator, company_generator, site_generator, city_generator, \
    functional_location_generator, ip_generator, technical_ident_generator, \
    hostid_generator, orderno_generator, contact_generator, public_ip_generator, \
    email_generator, fake_service_key, phone_generator

# --- anonymization switch ----------------------------------------------------
# The loader is written so the SAME procedure runs for the real take-over: set
# ANONYMIZE=0 (env) and every field passes through raw instead of being faked.
# Default ON (dev seeding). Free-text operator fields are replaced with a fixed
# placeholder when anonymizing (they cannot be structurally faked).
ANONYMIZE = os.environ.get("ANONYMIZE", "1").strip().lower() not in ("0", "false", "no", "off")
ANON_TEXT_PLACEHOLDER = "<content was anonymized during seeding>"

HERE = os.path.dirname(os.path.abspath(__file__))
# Prefer the normalized second_load export; fall back to the first export only
# for the denormalized VIEWS not present there (RDRSROUTERDETAILVIEWV1 -- gateways,
# until the gateway stage is migrated). RDGRANTVIEWV1 is no longer read after the
# normalized-grants rewrite.
SRC = os.path.join(HERE, "old_database", "second_load")
SRC_FALLBACK = os.path.join(HERE, "old_database", "first_load")

def src(name):
    p = os.path.join(SRC, name + ".csv.gz")
    return p if os.path.exists(p) else os.path.join(SRC_FALLBACK, name + ".csv.gz")

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
role_map    = IdMap(os.path.join(HERE, "role.map.json"))
account_map = IdMap(os.path.join(HERE, "account.map.json"))   # RDUSER.ID -> login_account uuid
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
notify_lbl  = LabelMap(os.path.join(HERE, "notify.map.json"),    email_generator())
pubip_lbl   = LabelMap(os.path.join(HERE, "pubip.map.json"),     public_ip_generator())  # real public IPs -> public-looking fakes
phone_lbl   = LabelMap(os.path.join(HERE, "phone.map.json"),     phone_generator())      # user phone/mobile (PII)
company_lbl = LabelMap(os.path.join(HERE, "company.map.json"),   company_generator())    # external user company (PII)

ALL_MAPS = [user_map, group_map, device_map, gateway_map, product_map, model_map, customer_map, site_map,
            role_map, account_map,
            hospital_lbl, customer_lbl, site_lbl, fl_lbl, ip_lbl, tid_lbl, host_lbl, ord_lbl, contact_lbl,
            city_lbl, notify_lbl, pubip_lbl, phone_lbl, company_lbl]

# --- anonymization helpers (all honor the ANONYMIZE switch) ------------------
def anon_map(m, raw):
    """Empty -> NULL; anonymize via LabelMap `m`, or pass raw when disabled."""
    v = (raw or "").strip()
    if not v:
        return None
    return m.get(v) if ANONYMIZE else v

def anon_hospital(raw, fallback_key):
    """Hospital name: faked via the shared map (keyed by fallback when empty),
    or the raw value when anonymization is off."""
    v = (raw or "").strip()
    if ANONYMIZE:
        return hospital_lbl.get(v or fallback_key)
    return v or None

def anon_serial(raw):
    """SERIAL: a fresh fake per row while seeding, or the raw serial otherwise."""
    v = (raw or "").strip()
    if ANONYMIZE:
        return fake_serial()
    return v or None

def anon_text(raw):
    """Operator free text: fixed placeholder while seeding (cannot be structurally
    faked), or the raw text otherwise. Empty -> NULL."""
    v = (raw or "").strip()
    if not v:
        return None
    return ANON_TEXT_PLACEHOLDER if ANONYMIZE else v

def anon_person(raw_first, raw_last, seq):
    """Person name: a random fake while seeding, or the raw first/last otherwise."""
    if ANONYMIZE:
        return fake_person()
    return ((raw_first or "").strip() or None, (raw_last or "").strip() or None)

def anon_email(raw_email, seq):
    """Email: a deterministic fake while seeding, or the raw address otherwise."""
    if ANONYMIZE:
        return fake_email(seq)
    return (raw_email or "").strip() or None

def anon_org2(lbl, key, real_name):
    """Customer/site display name from the NORMALIZED export (RDCUSTOMER /
    RDCUSTOMERSITE carry a real NAME). Fake keyed by id while seeding; the real
    name when ANONYMIZE=0."""
    if ANONYMIZE:
        return lbl.get(key)
    return (real_name or "").strip() or key

def anon_pcode(raw):
    """Postcode: dropped while seeding (identifying together with city), raw
    otherwise."""
    v = (raw or "").strip()
    if not v:
        return None
    return None if ANONYMIZE else v

def anon_pubip(raw):
    """Public IPsec endpoint IP: a stable public-looking fake per real IP while
    seeding, or the raw value otherwise. Empty/0 -> NULL."""
    v = (raw or "").strip()
    if not v or v == "0":
        return None
    return pubip_lbl.get(v) if ANONYMIZE else v

# Service keys are CREDENTIALS: the real->fake map is kept IN MEMORY ONLY (never
# written to a .map.json), stable within a run, shape-preserving (see
# fake_service_key). Empty -> NULL; raw when ANONYMIZE=0.
_svckey_cache: dict[str, str] = {}
def anon_svckey(raw):
    v = (raw or "").strip()
    if not v:
        return None
    if not ANONYMIZE:
        return v
    f = _svckey_cache.get(v)
    if f is None:
        f = fake_service_key(v); _svckey_cache[v] = f
    return f

def excluded_org(name, ann):
    """True for SYNTHETIC collector customers/sites that are not real orgs and
    must not be imported: the 'none' dummy and the 'SSL VPN' collection. NOT the
    (real) 'Service Partner Type2' parent site, and NOT the 'Gateway NAT' site
    (already invisible in the UI -- left as-is per owner review)."""
    n = (name or "").strip().lower()
    a = (ann or "").strip().lower()
    return n == "none" or "collect ssl vpn" in a

def notify_flags(raw):
    """Unpack the 4-char NOTIFYONACCESS code into 4 booleans.
    Positions: 1 m/0 access, 2 m/0 disconnect, 3 w/0 info-active, 4 a/0 pseudo.
    Blank -> all False (feature off); non-decodable -> all NULL (unknown)."""
    v = (raw or "").strip()
    if v == "":
        return (False, False, False, False)
    if len(v) == 4 and v[0] in "m0" and v[1] in "m0" and v[2] in "w0" and v[3] in "a0":
        return (v[0] == "m", v[1] == "m", v[2] == "w", v[3] == "a")
    return (None, None, None, None)

def state_code(raw):
    """Raw legacy enum code -> smallint, or NULL for blank / out-of-range noise
    (misaligned CSV rows carry junk like 460243681)."""
    v = (raw or "").strip()
    if not v or not v.lstrip("-").isdigit():
        return None
    n = int(v)
    return n if 0 <= n <= 32767 else None

# --- privilege catalog (CRUD x type; used only by ensure_privileges) ---------
CRUD_DEVICE = [("device","view"),("device","connect"),("device","edit"),("device","delete"),("device","create")]
CRUD_REGION = [("region","view"),("region","create"),("region","edit"),("region","delete")]
CRUD_GROUP  = [("group","view"),("group","create"),("group","edit"),("group","delete")]
CRUD_PRODUCT= [("product","view"),("product","create"),("product","edit"),("product","delete")]
CRUD_GATEWAY= [("gateway","view"),("gateway","create"),("gateway","edit"),("gateway","delete")]
CRUD_CUST   = [("customer","view"),("customer","create"),("customer","edit"),("customer","delete")]
CRUD_SITE   = [("site","view"),("site","create"),("site","edit"),("site","delete")]
CRUD_ROLE   = [("role","view"),("role","create"),("role","edit"),("role","delete")]
CRUD_SERVICE= [("service","view"),("service","create"),("service","edit"),("service","delete")]
ALL_TYPES   = (CRUD_DEVICE+CRUD_REGION+CRUD_GROUP+CRUD_PRODUCT+CRUD_GATEWAY+CRUD_CUST+
               CRUD_SITE+CRUD_ROLE+CRUD_SERVICE)

# --- privilege NAME -> (resource_type, verb) onto our CRUD catalog -----------
# The normalized RDPRIVILEGE names encode type+verb, e.g. "Customer System -
# Detail View" (device:view), "Router - Modify" (gateway:edit), "Customer and
# Customer Sites - Add" (customer:create). Prefix -> type; suffix -> CRUD verb.
# Types outside our authz surface (IP reservation, password pool, ...) -> None.
_PRIV_PREFIX = [
    ("Customer System", "device"), ("Census", "device"),
    ("Router", "gateway"),
    ("Customer and Customer Sites", "customer"),   # "on Site" -> site (handled below)
    ("User Group", "group"),
    ("Role", "role"),
    ("Region", "region"), ("Department", "region"),
    ("Product Model", "product"), ("Product Communication", "product"), ("Product", "product"),
    ("Service Domain", "service"), ("File Subscriber Server", "service"), ("File Subscription", "service"),
    ("Device Authorization", "service"), ("System Mgmt", "service"), ("Customer VPN", "service"),
    ("Client Updater", "service"), ("Extended File Processing", "service"), ("File Services", "service"),
    ("Event Log", "service"), ("Application Session Log", "service"), ("File Log", "service"),
    ("Portal Session", "service"), ("Operating System Log", "service"), ("Qualified Log", "service"),
    # not represented in our authz surface -> skipped
    ("User", None), ("IP Reservation", None), ("Password Pool", None), ("Usage Policies", None),
    ("SAP to SRS", None), ("Portal News", None), ("cRSP Portal", None), ("CWP User", None),
]

def privilege_tv(name):
    """Map an RDPRIVILEGE name to (resource_type, verb) in our catalog, or None."""
    n = (name or "").strip()
    rt = None
    for pre, t in _PRIV_PREFIX:
        if n.startswith(pre):
            rt = t
            break
    if rt is None:
        return None
    low = n.lower()
    if rt == "customer" and "on site" in low:
        rt = "site"
    if "establish connection" in low or "establish clientless" in low:
        vb = "connect"
    elif "- add" in low:
        vb = "create"
    elif "- delete" in low:
        vb = "delete"
    elif "view" in low:
        vb = "view"
    elif any(k in low for k in ("modify", "grant explicit", "set / release", "configure",
                                 "attach", "administrate", "update", "allow login", "commands",
                                 "distribute", "package", "reset password", "edit")):
        vb = "edit"
    else:
        vb = "view"
    if rt == "device" and vb == "create":
        return ("device", "create")
    return (rt, vb)

# in-memory lookups filled during reference stage
region_path: dict[str,str] = {}      # RDREGION.ID -> id-based ltree
region_iso:  dict[str,str] = {}      # RDREGION.ID -> ISO (country ancestor)
region_name: dict[str,str] = {}      # RDREGION.ID -> display name (for gateway.region)
admin_region_ids: set[str] = set()   # RDREGION.ID of REGIONTYPE=1 (administrative regions, dropped)
product_path: dict[str,str] = {}     # RDPRODUCT.ID -> id-based ltree
product_modality: dict[str,str] = {} # RDPRODUCT.ID -> top-level category name
product_model_path: dict[str,str] = {} # RDPRODUCTMODEL.ID -> model node ltree
model_partno: dict[str,str] = {}     # RDPRODUCTMODEL.ID -> PARTNUMBER (str), for the contract-flag join
gateway_src_ids: set = set()         # RSROUTER ids that actually got a gateway row
site_customer: dict[str,str] = {}    # RDCUSTOMERSITE.ID -> customer uuid (Slice A)
excluded_customer_src: set = set()   # RDCUSTOMER ids NOT imported (synthetic collectors)
excluded_site_src: set = set()       # RDCUSTOMERSITE ids NOT imported (synthetic collectors)
role_types: dict[str, set] = {}      # RDROLE.ID -> set of resource types it confers (Slice B)

# Slice G: legacy APPTYPE code -> kept FleetShell application. Dropped types
# (31 ping, 22 NetOp, 29 Novius, 24 X11, and every unused/obsolete protocol incl.
# pcanywhere/netmeeting/timbuktu/telnet) are simply absent -> never imported.
# See docs/second_load_analysis.md Slice G survey.
APP_MAP = {
    "1": "http", "43": "https", "16": "rdp", "12": "vnc", "3": "ssh",
    "49": "expert-i", "50": "teamviewer", "90": "transparent",
    "34": "scp", "33": "sftp", "27": "ftp",
}

# --- Slice D2: IPsec crypto decode (RDKEYTEXT TARGETREF 6030) -> ipsecnode tokens.
# Verified against the legacy GUI: ESP + remote_ts always come from RDIPSECSPD2
# POLICYTYPE=5; IKE is per-tunnel POLICYTYPE=1 for IKEv1, but the FIXED default
# profile for IKEv2 (IKEV2PROFILEID=1, uniform across all v2 routers). AH unused.
_ENC = {"2":"3des","3":"aes128","4":"aes192","5":"aes256",
        "6":"aes128gcm","7":"aes192gcm","8":"aes256gcm"}
_HASH = {"0":"none","1":"sha1","2":"md5","3":"sha256","4":"sha384","5":"sha512"}
_DH = {"1":1,"2":2,"3":5,"4":14,"5":15,"6":16,"7":19,"8":20,"9":21,"10":24}
# The Default IKEv2 Profile (owner-verified in the GUI; identical for every
# IKEV2PROFILEID=1 router). Proposal 1 = AES-CBC, Proposal 2 = AES-GCM.
_IKEV2_DEFAULT = {
    "ike_enc":  ["aes128", "aes192", "aes256", "aes128gcm", "aes256gcm"],
    "ike_auth": ["sha256", "sha384", "sha512"],
    "ike_dh":   [14, 15, 16, 20],
}

def build_ipsec_records():
    """Per-router IPsec crypto from RDIPSECSPD2 (Slice D2): POLICYTYPE=1 -> the
    IKEv1 proposal (used only for IKEv1 routers); POLICYTYPE=5 -> ESP crypto +
    the remote traffic selectors. No AH."""
    ike1, esp, rts, seen = {}, {}, {}, {}
    for r in read("RDIPSECSPD2"):
        t, pt = r["TUNNELID"], r["POLICYTYPE"]
        if pt == "1":
            ike1[t] = (_ENC.get(r["ESPENCRYPTION"]), _HASH.get(r["ESPAUTHENTICATION"]), _DH.get(r["KESECURITY"]))
        elif pt == "5":
            if t not in esp:
                esp[t] = (_ENC.get(r["ESPENCRYPTION"]), _HASH.get(r["ESPAUTHENTICATION"]), _DH.get(r["KESECURITY"]))
            ip = (r.get("IPADDRESS") or "").strip()
            if ip:
                sz = (r.get("SUBNETSIZE") or "").strip()
                ts = f"{ip}/{sz}" if sz else ip
                s = seen.setdefault(t, set())
                if ts not in s:
                    s.add(ts); rts.setdefault(t, []).append(ts)
    return {"ike1": ike1, "esp": esp, "rts": rts}


def _build_site_record(r, rid, ipsec_data, static_ip, pub):
    """Build (ipsec jsonb, psk) for one router. Returns (None, None) when the
    router has no tunnel (no POLICYTYPE=5 ESP crypto). Field names match the
    portal SiteRecord (gateway_spool.ts buildSiteRecord). No AH; local_ts is not
    in the source (authored later). PSK/dyndns are secrets not in the dump -> a
    fake under ANONYMIZE, else None (joined from the password store on takeover)."""
    esprec = ipsec_data["esp"].get(rid)
    if not esprec:
        return None, None
    ikever = (r.get("IKEPROTOCOLVERSION") or "").strip()
    profid = (r.get("IKEV2PROFILEID") or "0").strip()
    sr = {
        "ike_version": 2 if ikever == "2" else 1,
        "static_ip": static_ip,
    }
    ike_id = pub if ANONYMIZE else ((r.get("LOCALIDENTITY") or "").strip() or None)
    if ike_id:
        sr["ike_identity"] = ike_id
    if ikever == "2":
        if profid not in ("0", "1"):
            print(f"  [ipsec] WARN router {rid}: unexpected IKEV2PROFILEID {profid!r} "
                  f"(only the default profile 1 is known); using default")
        sr.update(_IKEV2_DEFAULT)                 # fixed default IKEv2 profile
    else:                                         # IKEv1 -> per-tunnel POLICYTYPE=1
        e, a, d = ipsec_data["ike1"].get(rid, (None, None, None))
        sr["ike_enc"] = [e] if e else []
        sr["ike_auth"] = [a] if a else []
        sr["ike_dh"] = [d] if d else []
    e, a, d = esprec                              # ESP from POLICYTYPE=5
    sr["esp_enc"] = [e] if e else []
    sr["esp_auth"] = [a] if a else []             # 'none' for AEAD/GCM
    sr["esp_pfs"] = [d] if d else []              # [] = no PFS
    sr["remote_ts"] = ipsec_data["rts"].get(rid, [])
    if not static_ip:
        sr["dyndns_password"] = uuid.uuid4().hex[:24] if ANONYMIZE else None
    psk = (uuid.uuid4().hex + uuid.uuid4().hex) if ANONYMIZE else None
    return psycopg.types.json.Json(sr), psk


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
        region_name[rid] = (r["NAME"] or rid)
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
        model_partno[mid] = (m["PARTNUMBER"] or "").strip()
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
        return anon_map(m, raw)
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
    country_name = {r["ID"]: (r["NAME"] or "").strip() for r in read("RDCOUNTRY")}
    ipsec_data = build_ipsec_records()   # Slice D2: per-router IPsec crypto
    n_ipsec = 0
    grows = []
    for r in read("RDRSROUTER"):
        rid = r["ID"]
        if rid in ("0", "") or (r.get("NAME") or "").strip().lower() == "dummy":
            continue                              # skip the dummy router
        gid = gateway_map.get(rid)
        gateway_src_ids.add(rid)
        regid = (r.get("REGIONID") or "").strip()
        rtype = (r.get("ROUTERTYPE") or "").strip()
        pub = anon_pubip(r.get("IPADDRESSIPSEC2"))
        # NOTE: hostname (DynDNS) is left NULL -- authored in the UI. region_path
        # + public_ip are REAL (REGIONID + IPADDRESSIPSEC2). gateway_model degrades
        # to the raw ROUTERTYPE code. IPsec crypto (Slice D2) reconstructed below.
        static_ip = (r.get("STATICIP") or "").strip() == "1"
        ipsec, psk = _build_site_record(r, rid, ipsec_data, static_ip, pub)
        if ipsec is not None:
            n_ipsec += 1
        grows.append((
            gid,
            region_name.get(regid, ""),                    # region (display name)
            hospital_lbl.get(r.get("IDENTIFIER2") or rid) if ANONYMIZE else (raw(r.get("IDENTIFIER2")) or raw(rid)),   # hospital (shared anon map)
            raw(r.get("NAME")),                            # name (router id / cisco serial) RAW
            an(city_lbl, r.get("IDENTIFIER1")),            # city (anon)
            None if rtype in ("", "0", "1") else rtype,    # gateway_model (raw ROUTERTYPE code)
            decode(CONN_LABELS, r.get("CONNECTIONTYPE")),      # connection_type (decoded)
            decode(OPSTATE_LABELS, r.get("OPERATIONALSTATE")), # operational_state (decoded)
            raw(r.get("STATICIP")),             # static_ip RAW
            raw(r.get("NATTYPE")),              # nat_type RAW
            an(ip_lbl, r.get("IPADDRESSADM1")), # admin_ip (anon)
            an(ip_lbl, r.get("IPADDRESSADM2")), # admin_ip2 (anon)
            country_name.get((r.get("COUNTRYID") or "").strip()) or None,  # country
            pub,                                # public_ip (REAL endpoint, anon)
            region_path.get(regid),             # region_path (ltree, from REGIONID)
            psk,                                # psk (fake under ANONYMIZE; Slice D2)
            ipsec,                              # ipsec SiteRecord jsonb (Slice D2)
        ))
    if emit:
        copy_rows(g, "gateway (id,region,hospital,name,city,gateway_model,connection_type,"
                     "operational_state,static_ip,nat_type,admin_ip,admin_ip2,country,public_ip,"
                     "region_path,psk,ipsec)",
                  grows, on_conflict="id")
        print(f"  gateway: {len(grows)} ({n_ipsec} with IPsec crypto)")


# =============================================================================
# STAGE: customers + sites (Slice A -- real master data)
# =============================================================================
def stage_customers(g: psycopg.Connection):
    """Import the REAL customer master + sites (RDCUSTOMER / RDCUSTOMERSITE),
    replacing the old per-site synthetic customer. Populates customer_map /
    site_map / site_customer for the device stage. Devices link via
    RDSERVICEDSYSTEM.SITEID -> RDCUSTOMERSITE.ID (~3.2k of 192k; the fleet is
    mostly flat). Names/addresses are anonymized; the real NAME is used when
    ANONYMIZE=0. Needs region_iso (built by stage_reference, which runs first)."""
    iso_by_country = {r["ID"]: (r.get("CODE3166") or "").strip() for r in read("RDCOUNTRY")}
    crows = []
    for r in read("RDCUSTOMER"):
        cid = r["ID"]
        if excluded_org(r.get("NAME"), r.get("ANNOTATIONS")):
            excluded_customer_src.add(cid); continue   # synthetic collector -> drop
        u = customer_map.get("C" + cid)
        iso = region_iso.get(r.get("REGIONID", "")) or ""
        crows.append((u, iso, anon_org2(customer_lbl, "C" + cid, r.get("NAME")),
                      (r.get("ACCESSPOLICY") or "").strip() == "1",
                      anon_map(city_lbl, r.get("CITY")), anon_pcode(r.get("POSTCODE")),
                      anon_text(r.get("STREET"))))
    copy_rows(g, "customer (id,country,name,requires_explicit_grant,city,postcode,street)",
              crows, on_conflict="id")
    srows = []
    for r in read("RDCUSTOMERSITE"):
        sid, custid = r["ID"], (r.get("CUSTOMERID") or "").strip()
        if excluded_org(r.get("NAME"), r.get("ANNOTATIONS")) or custid in excluded_customer_src:
            excluded_site_src.add(sid); continue    # synthetic collector (or its site) -> drop
        cust_u = customer_map.get("C" + custid) if custid not in ("0", "1", "") else None
        if cust_u is None:
            continue                       # site without a known customer -> skip
        u = site_map.get(sid)
        site_customer[sid] = cust_u
        iso = (iso_by_country.get(r.get("COUNTRYID", ""))
               or region_iso.get(r.get("REGIONID", "")) or "")
        srows.append((u, cust_u, iso, anon_org2(site_lbl, "S" + sid, r.get("NAME")),
                      (r.get("ACCESSPOLICY") or "").strip() == "1", "static",
                      anon_map(city_lbl, r.get("CITY")), anon_pcode(r.get("POSTCODE")),
                      anon_text(r.get("STREET"))))
    copy_rows(g, "customer_site (id,customer_id,country,name,requires_explicit_grant,"
                 "membership_kind,city,postcode,street)", srows, on_conflict="id")
    print(f"  customers: {len(crows)} (dropped {len(excluded_customer_src)} synthetic)  "
          f"sites: {len(srows)} (dropped {len(excluded_site_src)} synthetic)")


# =============================================================================
# STAGE: devices
# =============================================================================
def stage_devices(g: psycopg.Connection, limit: int | None):
    # Contract flags (Slice E), keyed by (model partno, real serial) -- a
    # 0-conflict key (verified); only equipment with a Y flag is stored. Under
    # ANONYMIZE the join still works because it uses the RAW serial. internal_use:
    # CON_TC_WO_U_FLG=Y -> 'NIU' (precedence), else CON_TC_FLG=Y -> 'STD', else
    # NULL. dpa from CON_DPA_FLG. dmy from RDSYSTEMDUMMYCONTRACT (SYSTEMID = device
    # id, ISACTIVE=1). See docs/valkey_spool.md (systems:by-ip contracts).
    contract_flags: dict[tuple, tuple] = {}
    for c in read("RDCMDBCONTRACTFLAGS"):
        dpa = c.get("CON_DPA_FLG") == "Y"
        iu = "NIU" if c.get("CON_TC_WO_U_FLG") == "Y" else ("STD" if c.get("CON_TC_FLG") == "Y" else None)
        if not dpa and iu is None:
            continue                       # all-N -> same as default, skip
        ser = (c.get("EQ_SERIAL_ID") or "").strip()
        if ser:
            contract_flags[((c.get("EQ_MAT_ID") or "").strip(), ser)] = (dpa, iu)
    dmy_devices = {(c.get("SYSTEMID") or "").strip() for c in read("RDSYSTEMDUMMYCONTRACT")
                   if (c.get("ISACTIVE") or "").strip() == "1"}
    print(f"  contracts: {len(contract_flags)} equipment w/flag, {len(dmy_devices)} active dummy")

    # Service keys (Slice F). A device may have many keys; pick the one it points
    # at (device.SERVICEKEYID) else the ISDEFAULT=1 key (latest expiry wins). The
    # key VALUE is a credential -> shape-preserving fake under ANONYMIZE; level +
    # expiry are non-secret metadata (kept raw). Transmitted in the tunnel request
    # by the portal Connect workflow.
    needed_skids = {(d.get("SERVICEKEYID") or "").strip() for d in read("RDSERVICEDSYSTEM")}
    needed_skids -= {"", "0", "1"}
    svc_by_id: dict[str, tuple] = {}     # kid -> (val,level,exp) for explicit pointers
    svc_all: dict[str, list] = {}        # sysid -> [(val,level,exp,is_default_src,kid)]
    for k in read("RDSERVICEKEY"):
        val = (k.get("SERVICEKEY") or "").strip()
        if not val:
            continue
        lvl = (k.get("ACCESSLEVEL") or "").strip() or None
        exp = (k.get("EXPIRATIONDATE") or "").strip() or None
        kid = k["ID"]
        if kid in needed_skids:
            svc_by_id[kid] = (val, lvl, exp)
        sid = (k.get("SERVICEDSYSID") or "").strip()
        if sid:
            svc_all.setdefault(sid, []).append((val, lvl, exp, (k.get("ISDEFAULT") or "").strip() == "1", kid))

    def resolve_default_key(sysid, skid):
        """(rec, kid) for the device's default: explicit SERVICEKEYID else the
        ISDEFAULT=1 key with the latest expiry."""
        if skid not in ("0", "1", "") and skid in svc_by_id:
            return svc_by_id[skid], skid
        best = best_kid = None
        for (val, lvl, exp, isdef, kid) in svc_all.get(sysid, []):
            if isdef and (best is None or (exp or "") > (best[2] or "")):
                best, best_kid = (val, lvl, exp), kid
        return best, best_kid

    dsk_rows = []   # device_service_key satellite (all keys)
    print(f"  service keys: {sum(len(v) for v in svc_all.values())} total over {len(svc_all)} systems")

    drows = []
    n = 0
    sysname_map: dict[str, str] = {}   # legacy RDSERVICEDSYSTEM.NAME -> new device UUID
    for r in read("RDSERVICEDSYSTEM"):
        n += 1
        if limit and n > limit: break
        did = device_map.get(r["ID"])
        nm = (r.get("NAME") or "").strip()
        if nm:
            sysname_map[nm] = did      # last wins on duplicate names
        rid = r["REGIONID"]
        pid = r["PRODUCTID"]
        pmid = (r.get("PRODUCTMODELID") or "").strip()
        iso = region_iso.get(rid) or None
        exp, esite = r["EXPLICITAUTHEXP"], r["EXPLICITAUTHSITE"]
        access = "device" if exp == "1" else ("site" if esite == "1" else "open")
        # Real customer/site link (Slice A): device.SITEID -> RDCUSTOMERSITE, whose
        # CUSTOMERID gives the customer. Flat devices (no SITEID) stay NULL.
        site_raw = (r.get("SITEID") or "").strip()
        site_u = site_map.get(site_raw) if site_raw in site_customer else None
        cust_u = site_customer.get(site_raw)

        na, nd, ninfo, npseudo = notify_flags(r.get("NOTIFYONACCESS"))
        # Contracts (Slice E): join equipment flags by (model partno, raw serial).
        dpa_flag, internal_use = contract_flags.get(
            (model_partno.get(pmid, ""), (r.get("SERIAL") or "").strip()), (False, None))
        dmy_flag = r["ID"] in dmy_devices
        # Service key (Slice F): resolved default onto device.*; ALL keys -> satellite.
        skid = (r.get("SERVICEKEYID") or "").strip()
        svc, default_kid = resolve_default_key(r["ID"], skid)
        svc_key = anon_svckey(svc[0]) if svc else None
        svc_level = svc[1] if svc else None
        svc_exp = svc[2] if svc else None
        for (val, lvl, exp, _isdef, kid) in svc_all.get(r["ID"], []):
            dsk_rows.append((did, anon_svckey(val), lvl, exp, kid == default_kid))

        drows.append((
            did,
            region_path.get(rid),
            iso,
            (product_modality.get(pid) or None),
            product_model_path.get(pmid) or product_path.get(pid),   # re-point to the MODEL node
            cust_u,
            site_u,
            gateway_map.get(r["RSROUTERID"]) if r.get("RSROUTERID") in gateway_src_ids else None,
            anon_hospital(r.get("HOSPITAL"), r["ID"]),
            None,                                   # software_version unknown in export
            access,
            psycopg.types.json.Json({}),
            anon_serial(r.get("SERIAL")),           # serial (SERIAL)
            anon_map(fl_lbl,   r.get("IDENTIFIER3")),   # functional_location
            anon_map(tid_lbl,  r.get("SYSTEMID2")),     # technical_ident
            anon_map(host_lbl, r.get("HOSTID")),        # host_hw_id
            anon_map(ord_lbl,  r.get("ORDERNO")),       # order_number
            anon_map(ip_lbl,   r.get("IPADDRESS1")),    # ip_address
            anon_map(ip_lbl,   r.get("REALIPADDRESS")), # ip_real (same map -> same fake per real ip)
            anon_map(contact_lbl, r.get("CONTACT")),    # contact (PII)
            anon_map(city_lbl, r.get("CITY")),          # city (anon; shared map with gateway city)
            state_code(r.get("CONFIGURATIONSTATE")),    # config_state (raw enum code)
            state_code(r.get("OPERATIONALSTATE")),      # operational_state (raw enum code)
            na, nd, ninfo, npseudo,                     # notify_* (unpacked NOTIFYONACCESS)
            anon_map(notify_lbl, r.get("NOTIFICATIONADDRESS")),  # notification_address (PII email)
            anon_text(r.get("SHOWONCONNECT")),          # display_before_connect (free text)
            anon_text(r.get("ANNOTATIONS")),            # additional_info (free text)
            internal_use, dpa_flag, dmy_flag,           # contracts: internal_use/dpa/dmy (Slice E)
            svc_key, svc_level, svc_exp,                 # service key + level + expiry (Slice F)
        ))
        if len(drows) >= 10000:
            _flush_devices(g, drows); drows.clear()
    _flush_devices(g, drows)
    # All service keys -> satellite (after devices exist, for the FK).
    copy_rows(g, "device_service_key (device_id,service_key,level,expires,is_default)", dsk_rows)
    print(f"  device_service_key: {len(dsk_rows)} rows")
    # Persist NAME -> device UUID so the infoproxy importer can attribute the
    # legacy Customer-System proxy bindings to the right (anonymized) device.
    # Written as a plain file (NOT an IdMap) so it survives the end-of-run map
    # destroy; regenerated on every reload. Gitignored (real system names).
    sysname_path = os.path.join(HERE, "sysname_device.map.json")
    with open(sysname_path, "w") as f:
        json.dump(sysname_map, f)
    print(f"  [sysname map] wrote {len(sysname_map)} NAME->device entries to {sysname_path} "
          f"(kept for import_infoproxy; NOT destroyed with the id maps)")
    print(f"  devices: {n if not limit else min(n,limit)}  "
          f"(customer/site link via SITEID -> RDCUSTOMERSITE)")


def _flush_devices(g, drows):
    if drows:
        copy_rows(g, "device (id,region_path,country_iso,modality,product_path,customer_id,"
                     "site_id,gateway_id,hospital_name,software_version,access_requirement,attrs,"
                     "serial,functional_location,technical_ident,host_hw_id,order_number,"
                     "ip_address,ip_real,contact,city,"
                     "config_state,operational_state,notify_on_access,notify_on_disconnect,"
                     "notification_info_active,notify_pseudonymized,notification_address,"
                     "display_before_connect,additional_info,internal_use,dpa,dmy,"
                     "service_key,service_key_level,service_key_expires)", drows, on_conflict="id")


# =============================================================================
# STAGE: applications (Slice G core -- product_model_app + device_app)
# =============================================================================
def stage_apps(g: psycopg.Connection):
    """Model default apps (product_model_app) from the profile templates, and
    per-device overrides (device_app) from the per-system app configs. Every
    model maps 1:1 to an app profile (via its devices' APPPROFILEID); the
    profile's SYSTEMID=0 template rows are the model defaults, and SYSTEMID=<dev>
    rows are that device's full override. Only kept application types (APP_MAP)
    are imported. Parameter mapping (sni/path/guac dims from RDSERVAPPPROP) is a
    second pass -- this brings application + port + name. Needs model_map
    (reference) + device_map (devices)."""
    # model -> app profile (1:1 via devices' APPPROFILEID)
    model_profile: dict[str, str] = {}
    for r in read("RDSERVICEDSYSTEM"):
        mid = (r.get("PRODUCTMODELID") or "").strip()
        ap = (r.get("APPPROFILEID") or "").strip()
        if mid and ap not in ("0", ""):
            model_profile.setdefault(mid, ap)
    # profile -> template rows (SYSTEMID=0); device -> override rows (SYSTEMID set).
    # Each rec carries the RDSERVAPPPAR.ID so G-full props (path/ports/options)
    # can be attached below.
    profile_tmpl: dict[str, list] = {}
    device_over: dict[str, list] = {}
    apppar_app: dict[str, str] = {}
    kept = dropped = 0
    for r in read("RDSERVAPPPAR"):
        app = APP_MAP.get((r.get("APPTYPE") or "").strip())
        if not app:
            dropped += 1; continue
        kept += 1
        aid = r["ID"]; apppar_app[aid] = app
        port = (r.get("PORTNUMBER") or "").strip()
        rec = (aid, (r.get("APPNAME") or "").strip() or app, app, "" if port in ("0", "") else port)
        sysid = (r.get("SYSTEMID") or "0").strip()
        if sysid not in ("0", ""):
            device_over.setdefault(sysid, []).append(rec)
        else:
            profile_tmpl.setdefault((r.get("PROFILEID") or "").strip(), []).append(rec)

    # G-full: attach per-app-config params from RDSERVAPPPROP (kept fields only).
    #   Homepage File -> path (http/https). Extra/plain TCP Ports -> fold into the
    #   comma-list `ports` (the gateway/client already do multi-port TCP forwards).
    #   Extra/plain UDP Ports -> params.udp_ports (no UDP in the gateway yet).
    #   teamviewer Options -> params.options (raw, stored for when the app is built).
    props: dict[str, dict] = {}
    for r in read("RDSERVAPPPROP"):
        ap = apppar_app.get(r["APPPARID"])
        if not ap:
            continue
        tag = (r.get("TAG") or "").strip(); val = (r.get("VALUE") or "").strip()
        d = props.setdefault(r["APPPARID"], {})
        if tag == "Homepage File" and ap in ("http", "https"):
            d["path"] = val
        elif tag in ("Extra TCP Ports", "TCP Ports") and ap in ("https", "transparent"):
            d["tcp"] = val
        elif tag in ("Extra UDP Ports", "UDP Ports") and ap in ("https", "transparent"):
            d["udp"] = val
        elif tag == "Options" and ap == "teamviewer" and val:
            d.setdefault("opts", []).append(val)

    def split_ports(s):
        return [p for p in (t.strip() for t in (s or "").split(",")) if p and p != "0"]

    def app_cols(rec):
        """(name, application, ports, path, params) for an app config rec."""
        aid, name, app, port = rec
        p = props.get(aid, {})
        ports = split_ports(port) + [x for x in split_ports(p.get("tcp", "")) if x not in split_ports(port)]
        path = p.get("path") or "/"
        params = {}
        udp = split_ports(p.get("udp", ""))
        if udp:
            params["udp_ports"] = udp
        if p.get("opts"):
            params["options"] = "; ".join(dict.fromkeys(p["opts"]))
        return name, app, ",".join(ports), path, (psycopg.types.json.Json(params) if params else None)
    # product_model_app (model defaults)
    pma_rows = []
    for mid, prof in model_profile.items():
        if not model_map.has(mid):
            continue
        node = model_map.get(mid)
        for i, rec in enumerate(profile_tmpl.get(prof, [])):
            name, app, ports, path, params = app_cols(rec)
            pma_rows.append((node, name, app, ports, path, params, i))
    copy_rows(g, "product_model_app (product_id,name,application,ports,path,params,sort_order)", pma_rows)
    # device_app (per-device overrides)
    da_rows = []
    for sysid, apps in device_over.items():
        if not device_map.has(sysid):
            continue
        dev = device_map.get(sysid)
        for i, rec in enumerate(apps):
            name, app, ports, path, params = app_cols(rec)
            da_rows.append((dev, name, app, ports, path, params, i))
    copy_rows(g, "device_app (device_id,name,application,ports,path,params,sort_order)", da_rows)
    print(f"  apps: {len(pma_rows)} model defaults, {len(da_rows)} device overrides "
          f"(kept {kept} app rows, dropped {dropped} of dropped types)")


# =============================================================================
# STAGE: users (LOCAL plane)
# =============================================================================
def stage_users(l: psycopg.Connection, limit: int | None):
    # Slice H (Option 1 -- correct identity model): each RDUSER is a HUMAN. It
    # becomes a login_account (name/email/phone/mobile/company + status/PII) PLUS
    # a 1:1 app_user persona (the 'hat': name + DTM country) linked via
    # account_persona (is_primary). PII lives on the ACCOUNT, not the persona.
    # The dev login accounts + 6 test personas are added AFTER, by
    # seed_test_users.py + seed_login_accounts.mjs (distinct usernames/ids, so
    # they are preserved).
    iso_by_country = {r["ID"]: (r["CODE3166"] or "").strip() for r in read("RDCOUNTRY")}
    WANT = {"User Type from GAMA": "user_type", "CompanyName": "company",
            "ExpirationDate": "expires"}
    props: dict[str, dict] = {}
    for p in read("RDUSERPROPERTY"):
        tag = WANT.get((p.get("TAG") or "").strip())
        if tag:
            props.setdefault(p["USERID"], {})[tag] = (p.get("VALUE") or "").strip() or None
    STATE = {"0": "active", "21": "expired", "11": "disabled"}

    persona_rows, account_rows, link_rows = [], [], []
    seen_user, seen_email = set(), set()
    n = have = 0
    for r in read("RDUSER"):
        n += 1
        if limit and n > limit: break
        rid = r["ID"]
        uid = user_map.get(rid)                       # persona (app_user) id
        acct_id = "acct:" + account_map.get(rid)      # login_account id
        fn, ln = anon_person(r.get("FIRSTNAME"), r.get("LASTNAME"), n)
        cid = (r.get("COUNTRYID") or "").strip()
        country = iso_by_country.get(cid) or None if cid not in ("0", "") else None
        if country: have += 1
        pr = props.get(rid, {})
        email_val = anon_email(r.get("EMAIL"), n)

        # persona (app_user): the 'hat' -- name + optional contact email + DTM country.
        persona_rows.append((uid, "eu-west-2", fn, ln, email_val, None, country))

        # account (login_account): the human + PII. username/email must be UNIQUE.
        username = ("u" + rid) if ANONYMIZE else ((r.get("NAME") or "").strip() or ("u" + rid))
        if username in seen_user:
            username = f"{username}_{rid}"
        seen_user.add(username)
        email = email_val if (email_val and email_val not in seen_email) else f"u{rid}@imported.local"
        seen_email.add(email)
        account_rows.append((
            acct_id, username, email, None, (f"{fn} {ln}").strip(),
            anon_map(phone_lbl, r.get("PHONE")),          # phone (PII)
            anon_map(phone_lbl, r.get("MOBILEPHONE")),    # mobile (PII)
            anon_map(company_lbl, pr.get("company")),     # external company (PII)
            STATE.get((r.get("STATE") or "").strip()),    # account_state
            pr.get("user_type"),                          # GAMA user type
            pr.get("expires"),                            # account_expires
        ))
        # link (account_persona): 1:1, primary.
        link_rows.append((acct_id, uid, True))

    copy_rows(l, "app_user (user_id,home_region,firstname,lastname,email,theme,country)",
              persona_rows, on_conflict="user_id")
    copy_rows(l, "login_account (account_id,username,email,password_hash,display_name,"
                 "phone,mobile,company,account_state,user_type,account_expires)",
              account_rows, on_conflict="account_id")
    copy_rows(l, "account_persona (account_id,user_id,is_primary)", link_rows,
              on_conflict="account_id,user_id")
    print(f"  users: {len(persona_rows)} personas + {len(account_rows)} accounts "
          f"({have} with country, {len(props)} with properties)")


# =============================================================================
# STAGE: roles + privileges (Slice B -- RDROLE / RDPRIVILEGE / RDPRIVILEGE2ROLE)
# =============================================================================
def stage_roles(g: psycopg.Connection):
    """Import the real role catalog. Each RDPRIVILEGE name maps onto our CRUD
    catalog via privilege_tv(); RDPRIVILEGE2ROLE gives role->privileges. Also
    builds role_types (RDROLE.ID -> {resource types}) which the grant stage uses
    to decide whether a grant yields a device and/or gateway scope."""
    priv_tv = {}
    for r in read("RDPRIVILEGE"):
        tv = privilege_tv(r["NAME"])
        if tv:
            priv_tv[r["ID"]] = tv
    rrows = []
    for r in read("RDROLE"):
        rid = r["ID"]; u = role_map.get(rid)
        role_types.setdefault(rid, set())
        rrows.append((u, (r["NAME"] or rid)[:56] + "-" + u[:8], (r["NAME"] or rid)[:120]))
    copy_rows(g, "authz_role (id,key,name)", rrows, on_conflict="id")
    rp = []
    for r in read("RDPRIVILEGE2ROLE"):
        tv = priv_tv.get(r["PRIVILEGEID"]); rid = r["ROLEID"]
        if not tv or rid not in role_types:
            continue
        role_types[rid].add(tv[0])
        rp.append((role_map.get(rid), tv[0], tv[1]))
    with g.cursor() as c:
        c.executemany(
            "INSERT INTO authz_role_privilege(role_id,privilege_id) "
            "SELECT %s, id FROM authz_privilege WHERE resource_type=%s AND verb=%s "
            "ON CONFLICT DO NOTHING", rp)
    g.commit()
    print(f"  roles: {len(rrows)}  role-privileges: {len(rp)}")


# =============================================================================
# STAGE: grants (Slice C -- RDBASEGRANT + RDGROUPGRANT, normalized)
# =============================================================================
def stage_grants(g: psycopg.Connection, l: psycopg.Connection, limit: int | None):
    """Normalized grant import. Scope dimensions come from the polymorphic
    OBJREF/VALUE columns (region=ATTR1/1120, product=ATTR2/5110, customer=
    ATTR3/5210, site=ATTR3/5220, single device=ID/6010; value 1 = ANY). The
    resource TYPE follows the role's privileges (role_types): a role with device
    privileges yields a device scope; one with gateway (Router) privileges a
    gateway (region-only) scope. Groups + hierarchy from RDUSERGROUP (replaces
    build_group_hierarchy.py); memberships from RDUSER2GROUP. Per-user grants
    (RDBASEGRANT.GRANTEEID) attach to a synthetic 'user:<id>' group whose sole
    member is that user. A grant scoped to a dropped (administrative) region is
    skipped, never widened."""
    known_users = {r["ID"] for r in read("RDUSER")}

    # --- real groups with hierarchy (RDUSERGROUP.PARENTID) ---
    ug = list(read("RDUSERGROUP"))
    ug_ids = {r["ID"] for r in ug}
    gparent = {r["ID"]: (r.get("PARENTID") or "").strip() for r in ug}
    def gpath(gid):
        chain = [gid]; seen = {gid}; p = gparent.get(gid, "")
        while p and p in ug_ids and p not in seen:
            chain.append(p); seen.add(p); p = gparent.get(p, "")
        return ".".join(reversed(chain))
    grp_rows, parent_pairs = [], []
    for r in ug:
        gid = r["ID"]; u = group_map.get(gid)
        grp_rows.append((u, "eu-west-2", (r["NAME"] or gid)[:120], gpath(gid), None))
        pid = gparent.get(gid, "")
        if pid in ug_ids and pid != gid:
            parent_pairs.append((group_map.get(pid), u))
    copy_rows(g, "principal_group (group_id,home_region,label,path,parent_id)", grp_rows, on_conflict="group_id")
    with g.cursor() as c:   # parent_id in a 2nd pass (self-FK ordering)
        c.executemany("UPDATE principal_group SET parent_id=%s WHERE group_id=%s", parent_pairs)
    g.commit()

    # --- real memberships (RDUSER2GROUP) ---
    seen_mem, member_rows = set(), []
    for r in read("RDUSER2GROUP"):
        gid, uid = r["GROUPID"], r["USERID"]
        if gid not in ug_ids or uid not in known_users:
            continue
        key = (group_map.get(gid), user_map.get(uid))
        if key in seen_mem: continue
        seen_mem.add(key); member_rows.append(key)

    # --- scope helpers (device + gateway) ---
    scope_cache = {}
    scope_rows, constraint_rows, scope_device_rows = [], [], []
    def dev_scope(reg, prod, cust, site):
        key = ("dev", reg, prod, cust, site)
        if key not in scope_cache:
            u = str(uuid.uuid4()); scope_cache[key] = u
            scope_rows.append((u, "device", "attribute", ""))
            if reg:  constraint_rows.append((u, "region_path", "subtree", "{"+reg+"}"))
            if prod: constraint_rows.append((u, "product_path", "subtree", "{"+prod+"}"))
            if cust: constraint_rows.append((u, "customer_id", "in", "{"+cust+"}"))
            if site: constraint_rows.append((u, "site_id", "in", "{"+site+"}"))
        return scope_cache[key]
    def dev_single(device_u):
        key = ("single", device_u)
        if key not in scope_cache:
            u = str(uuid.uuid4()); scope_cache[key] = u
            scope_rows.append((u, "device", "single_system", ""))
            scope_device_rows.append((u, device_u))
        return scope_cache[key]
    def gw_scope(reg):
        key = ("gw", reg)
        if key not in scope_cache:
            u = str(uuid.uuid4()); scope_cache[key] = u
            scope_rows.append((u, "gateway", "attribute", ""))
            if reg: constraint_rows.append((u, "region_path", "subtree", "{"+reg+"}"))
        return scope_cache[key]

    # --- synthetic per-grantee-user groups (lazy) ---
    syn_group_rows, seen_syn = [], set()
    def user_group(uid):
        u = group_map.get("U"+uid)
        if u not in seen_syn:
            seen_syn.add(u)
            syn_group_rows.append((u, "eu-west-2", ("user:"+uid)[:120], "u"+u.replace("-","")[:30], None))
            member_rows.append((u, user_map.get(uid)))
        return u

    grant_rows, seen_grants = [], set()
    stats = {"device": 0, "gateway": 0, "skipped": 0, "norole": 0}

    def decode(r):
        reg  = region_path.get(r["ATTR1VALUE"]) if r["ATTR1OBJREF"] == "1120" and r["ATTR1VALUE"] not in ("0","1","") else None
        prod = product_path.get(r["ATTR2VALUE"]) if r["ATTR2OBJREF"] == "5110" and r["ATTR2VALUE"] not in ("0","1","") else None
        a3r, a3v = r["ATTR3OBJREF"], r["ATTR3VALUE"]
        cust = customer_map.get("C"+a3v) if a3r == "5210" and a3v not in ("0","1","") and customer_map.has("C"+a3v) else None
        site = site_map.get(a3v) if a3r == "5220" and a3v not in ("0","1","") and a3v in site_customer else None
        idv = r["IDVALUE"]
        dev = device_map.get(idv) if r["IDOBJREF"] == "6010" and idv not in ("0","1","") and device_map.has(idv) else None
        return reg, prod, cust, site, dev

    def add_grant(group_u, r):
        roleid = r["ROLEID"]
        types = role_types.get(roleid)
        if types is None:
            stats["norole"] += 1; return
        # region scoped to a dropped (administrative) region -> skip, don't widen
        if r["ATTR1OBJREF"] == "1120":
            rv = r["ATTR1VALUE"]
            if rv not in ("0","1","") and region_path.get(rv) is None:
                stats["skipped"] += 1; return
        # scope to a dropped SYNTHETIC customer/site -> skip (don't widen)
        a3r, a3v = r["ATTR3OBJREF"], r["ATTR3VALUE"]
        if a3v not in ("0", "1", "") and (
                (a3r == "5210" and a3v in excluded_customer_src)
                or (a3r == "5220" and a3v in excluded_site_src)):
            stats["skipped"] += 1; return
        reg, prod, cust, site, dev = decode(r)
        rl = role_map.get(roleid)
        made = False
        if "device" in types:
            sc = dev_single(dev) if dev is not None else dev_scope(reg, prod, cust, site)
            key = (group_u, rl, sc)
            if key not in seen_grants:
                seen_grants.add(key); grant_rows.append((str(uuid.uuid4()), group_u, rl, sc)); stats["device"] += 1
            made = True
        if "gateway" in types:
            sc = gw_scope(reg)
            key = (group_u, rl, sc)
            if key not in seen_grants:
                seen_grants.add(key); grant_rows.append((str(uuid.uuid4()), group_u, rl, sc)); stats["gateway"] += 1
            made = True
        if not made:
            stats["skipped"] += 1

    def flush():
        if syn_group_rows:
            copy_rows(g, "principal_group (group_id,home_region,label,path,parent_id)", syn_group_rows, on_conflict="group_id"); syn_group_rows.clear()
        if scope_rows:
            copy_rows(g, "authz_scope (id,resource_type,kind,label)", scope_rows, on_conflict="id"); scope_rows.clear()
        if constraint_rows:
            copy_rows(g, "authz_scope_constraint (scope_id,dimension,op,values)", constraint_rows); constraint_rows.clear()
        if scope_device_rows:
            copy_rows(g, "authz_scope_device (scope_id,device_id)", scope_device_rows, on_conflict="scope_id,device_id"); scope_device_rows.clear()
        if grant_rows:
            copy_rows(g, "authz_grant (id,group_id,role_id,scope_id)", grant_rows, on_conflict="id"); grant_rows.clear()

    n = 0
    for r in read("RDBASEGRANT"):
        n += 1
        if limit and n > limit: break
        gid = r["GRANTEEID"]
        if gid not in known_users:
            stats["norole"] += 1; continue
        add_grant(user_group(gid), r)
        if len(grant_rows) >= 20000:
            flush()
    for r in read("RDGROUPGRANT"):
        gid = r["GROUPID"]
        if gid in ug_ids:
            grp = group_map.get(gid)
        elif gid in known_users:
            grp = user_group(gid)
        else:
            stats["norole"] += 1; continue
        add_grant(grp, r)
        if len(grant_rows) >= 20000:
            flush()
    flush()
    copy_rows(l, "group_membership (group_id,user_id)", member_rows, on_conflict="group_id,user_id")
    print(f"  grants: device {stats['device']}, gateway {stats['gateway']}, "
          f"skipped {stats['skipped']}, no-role/unknown-grantee {stats['norole']}; "
          f"groups {len(ug_ids)} real + {len(seen_syn)} synthetic, members {len(member_rows)}, "
          f"scopes {len(scope_cache)}")


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
        n_from = len(matrices)
        for i, (from_iso, byvar) in enumerate(sorted(matrices.items()), 1):
            print(f"    dtm [{i}/{n_from}] {from_iso}: {len(byvar)} variant(s)...", flush=True)
            c_deny0 = n_deny
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
            g.commit()   # commit per FROM-country so progress is durable + visible
            print(f"      {from_iso}: {n_deny - c_deny0} denied cells", flush=True)
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
        print("customers:"); stage_customers(g)
    if a.stage in ("all","devices"):
        print("devices:");   stage_devices(g, a.limit)
        print("apps:");      stage_apps(g)
    if a.stage in ("all","users"):
        print("users:");     stage_users(l, a.limit)
    if a.stage in ("all","grants"):
        print("roles:");     stage_roles(g)
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
        print("id maps destroyed (import is now irreversible); "
              "sysname_device.map.json is intentionally kept for import_infoproxy")
    else:
        print("id maps kept (rerun-friendly). Delete *.map.json when done.")


if __name__ == "__main__":
    main()
