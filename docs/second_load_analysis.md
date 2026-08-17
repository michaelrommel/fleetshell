# Second-load export analysis: closing the reverse-engineering gaps

The new dump in `infrastructure/import/old_database/second_load/` is the **real
normalized source schema** (base tables), not the denormalized *views* the
current `load.py` was reverse-engineered against (`RDGRANTVIEWV1`,
`RDRSROUTERDETAILVIEWV1`, the old flat `RDSERVICEDSYSTEM`). All files are
uncompressed, `;`-delimited, double-quoted, UTF-8/CRLF.

Data Classification and the Data Transfer Matrix stay Excel-sourced (owner
decision -- the legacy denormalization is messier than the clean spreadsheets).

## 0. Foundational change: source + reader

- Current: `read(name)` reads `old_database/<name>.csv.gz` (gzip). The new files
  live uncompressed in `old_database/second_load/`.
- Plan: add `read2(name)` reading `second_load/<name>.csv` (or gz-compress the
  large ones -- `RDBASEGRANT` 155 MB, `RDSERVICEKEY` 242 MB, `RDSERVAPPPROP`
  125 MB -- and keep one reader). Migrate stages one at a time; ANONYMIZE stays.
- The new `RDSERVICEDSYSTEM` has a DIFFERENT column set than the view the current
  device stage reads (e.g. `CUSTOMERSITEID`, `SERVICEKEYID`, `SYSFROMSAPID`,
  `PRODUCTMODELID`, `RSROUTERID`, `IPADDRESS1/REALIPADDRESS` are all present),
  so the device stage column mapping must be revised regardless.

## 1. What was missing before -> now available

| Gap (old) | New table(s) | Notes |
|---|---|---|
| **Customer master** (synthesized 1:1 per site) | `RDCUSTOMER` (66), `RDCUSTOMERSITE` (297) | Real customers + their sites; `RDCUSTOMERSITE.CUSTOMERID` -> customer. Address fields present. |
| **Device -> customer/site** (`CUSTOMERID` empty) | device `CUSTOMERSITEID` (6% set) -> `RDCUSTOMERSITE` -> `CUSTOMERID` | Most devices are flat (94% no site) -- matches expectation. `CUSTOMERID` on device still 0%; resolve via the site. |
| **Physical site / address** | `RDSITEFROMSAP` (113k), device `SYSFROMSAPID` (88%) | Real SAP customer addresses (name/street/city/postcode/country/region), distinct from the `RDCUSTOMERSITE` groupings. |
| **Roles + privileges (source of truth)** | `RDROLE` (129), `RDPRIVILEGE` (154), `RDPRIVILEGE2ROLE` (974) | Replaces the hand-maintained `ROLE_PRIVS` dict AND the `GATEWAY_ROLES` heuristic. Privilege NAME encodes type+verb: "Customer System - Detail View" = device:view, "Router - Modify" = gateway:edit, "Customer and Customer Sites - Add" = customer/site:create, "User/Role/Group - ...", etc. |
| **Normalized grants** | `RDBASEGRANT` (980k), `RDGROUPGRANT` (25k) | Polymorphic ABAC: `IDOBJREF/IDVALUE` = primary object (single-system when set), `ATTR{1,2,3}OBJREF/VALUE` = attribute constraints; `a%` = wildcard. OBJREF are type codes (1120 = region, others product/customer/site -- to be decoded). This is essentially our scope model, 1:1. |
| **Gateway/router grants** (role-name guess) | falls out of `RDPRIVILEGE` "Router - *" | The `SRSConfiguration`/`RouterConfigFunc`/... work becomes exact: the ROLE holds "Router - *" privileges -> gateway resource type, no heuristic set. |
| **Service domains** ("router - *" style named sets) | `RDSDOMAIN` (26), `RDSDGRANT` (54), `RDSDMEMBERSHIP` (503) | Named attribute/id sets -> decompose into our scopes (design already anticipated this; only ~26 exist). |
| **Real gateway detail** | `RDRSROUTER` (26k) | Full router record: region/site/country, IPsec fields (IKE version, identities, NAT type, static IP), admin IPs. Replaces the enrich-view mapping. |
| **Real IPsec params** (synthesized before) | `RDIPSECSPD2` (172k) | Per-tunnel policy: ESP/AH auth, encryption, mode, local/remote endpoints -> the `fleetipsec:site` SiteRecord for real instead of synthetic. |
| **Device -> gateway** | device `RSROUTERID` (92%), `RDSYSTEMS2ROUTER` (177k) | Direct + mapping table (with access-server ids). |
| **Gateway -> physical site** | `RDSITE2ROUTER` (54) | Router placement -> `RDSITEFROMSAP`. |
| **Contracts (DPA/STD/NIU/DMY)** | `RDCMDBCONTRACTFLAGS` (1.05M: `CON_DPA_FLG`->DPA, `CON_TC_FLG`->STD, `CON_TC_WO_U_FLG`->NIU), `RDSYSTEMDUMMYCONTRACT` (861 -> DMY) | Real contract flags keyed by equipment serial; today these are guessed/empty. |
| **Service keys** | `RDSERVICEKEY` (403k), device `SERVICEKEYID` (5%) | Per-device tunnel service key (owner: store per device + transmit in the tunnel request). New capability, not just a gap. |
| **Per-system app overrides** | `RDSERVAPPPAR` (130k), `RDSERVAPPPROP` (788k), `RDAPPPROFILE` (1465), `RDAPPPROFILE2APP` (176), `RDPRODUCT2PROFILE`/`RDPRODUCT2APPPROFILE`, `RDPRODUCTPROFILE` | The deferred `device_app` feature: model-level app profiles + per-system parameter/property overrides. Feeds `product_model_app` + `device_app`. |
| **User country + properties** | `RDUSER` (7751) + `RDUSERPROPERTY` (112k) + `RDUSER2GROUP` (9413) + `RDUSERGROUP` (1104) | Personas, country (already partly via `RDCOUNTRY`), group membership -- all from base tables instead of the grant view. |

## 2. Column-population reality (192k devices scanned)

`RSROUTERID` 92%, `IPADDRESS1` 99%, `REALIPADDRESS` 41%, `PRODUCTMODELID` 99%,
`COUNTRYID` 100%, `SYSFROMSAPID` 88%, `CUSTOMERSITEID` 6%, `SITEID` 1%,
`SERVICEKEYID` 5%, `CUSTOMERID` 0%. So: gateway link, IP, model, country are
solid; customer-site membership is real but sparse (flat fleet); service keys are
sparse (only the systems that have one).

## 3. Proposed improvement slices (prioritized)

**Status: the interlocked core (A+B+C) is IMPLEMENTED in `load.py` and validated
by a full dry-run against the real files (DB writes mocked). Row counts the live
import will COPY: 1.28M grants, 8,261 groups (1,048 real + 7,213 synthetic
user-groups), 47 roles / 866 role-privileges, 61 customers / 294 sites, 9,813
scopes (308 single-system), 16,626 memberships. `no-role/unknown-grantee = 0`.**

Interlocked core (biggest correctness win) -- DONE:

- **A. Customer/Site master.** `stage_customers()` imports RDCUSTOMER (59) +
  RDCUSTOMERSITE (293); devices link via **`RDSERVICEDSYSTEM.SITEID` ->
  RDCUSTOMERSITE -> CUSTOMERID** (~3.2k devices; `CUSTOMERSITEID` is actually the
  physical SAP site, and `CUSTOMERID` is empty -- both red herrings). The
  synthetic 1:1 customer fallback is gone. Real NAME used when ANONYMIZE=0.
  **Synthetic collectors are excluded** (`excluded_org()`): the `none` dummy and
  the `SSL VPN` collection (customer 2643670 / site 2643671) -- these are
  technical buckets, not real orgs. Grants scoped to a dropped collector are
  skipped (not widened). The real `Service Partner Type2` parent site (245 sites)
  and the `Gateway NAT` site (invisible in the UI) are KEPT.
- **B. Roles & privileges from source.** `stage_roles()` imports
  RDROLE/RDPRIVILEGE/RDPRIVILEGE2ROLE; `privilege_tv()` maps each privilege NAME
  onto our CRUD catalog (100% of 154 privileges resolve or are explicitly
  skipped). `ROLE_PRIVS`/`GATEWAY_ROLES`/`DEFAULT_PRIVS` deleted.
- **C. Normalized grants.** `stage_grants()` rebuilt on RDBASEGRANT (per-user) +
  RDGROUPGRANT (per-group). Scope dims decoded from the OBJREF/VALUE model
  (region=ATTR1/1120, product=ATTR2/5110, customer=ATTR3/5210, site=ATTR3/5220,
  single device=ID/6010; value 1 = ANY). Resource TYPE per grant follows the
  role's privileges: device privileges -> device scope, gateway (Router)
  privileges -> gateway (region-only) scope (so the legacy `User` role's
  "Router - Detail View" correctly yields region-scoped gateway VIEW, and
  SRSConfiguration/SuperUser the full maintainer set). Admin-region grants are
  dropped (never widened). **Group tree + memberships now come from
  RDUSERGROUP.PARENTID + RDUSER2GROUP -> `build_group_hierarchy.py` + groups.txt
  are retired; the reload.sh step was removed.**

High-value follow-ons (independent, NOT yet done):

- **D. Gateways + real IPsec.**
  - **D1 (DONE).** The gateway stage now reads the BASE table `RDRSROUTER`
    (second_load) instead of the first_load view `RDRSROUTERDETAILVIEWV1` -- the
    LAST first_load dependency for a live stage is gone. `gateway.region_path`
    comes straight from `REGIONID` (exact; the name-match backfill in
    `migrate_gateway_authz.sql` is now a safety net), and `public_ip` is the REAL
    IPsec endpoint `IPADDRESSIPSEC2` (anonymized via a new `pubip_lbl` map;
    ~70% populated) instead of a synthesized value. country from `COUNTRYID`,
    device->gateway via `device.RSROUTERID` (92%). Validated: 20,122 gateways,
    177,724/192,387 devices linked. Cosmetic regression: `gateway_model` is now
    the raw `ROUTERTYPE` code (the decoded `DISPLAYROUTERTYPE` lived only in the
    retired view; add a `RDROUTERTYPE` decode if that table is exported).
  - **D2 (DONE).** Real IPsec crypto SiteRecord reconstructed from `RDRSROUTER`
    + `RDIPSECSPD2`, verified against the legacy GUI. Rules: **ESP + remote_ts**
    always from `RDIPSECSPD2 POLICYTYPE=5`; **IKE** = per-tunnel `POLICYTYPE=1`
    for IKEv1 (`IKEV2PROFILEID=0`), or the FIXED default IKEv2 profile (AES-CBC
    128/192/256 + AES-GCM 128/256, SHA256/384/512, DH 14/15/16/20) for IKEv2
    (`IKEV2PROFILEID=1`, uniform across all 5,136 v2 routers -- the varied
    `POLICYTYPE=1` values on v2 rows are stale/ignored). **No AH.** Crypto codes
    decode via RDKEYTEXT (TARGETREF 6030). Field names match the portal
    `buildSiteRecord` (ike_version/static_ip/ike_identity/ike_*/esp_*/remote_ts).
    Populates `gateway.ipsec` (jsonb) + `gateway.psk` in the gateway import.
    Validated: 18,790 of 20,122 gateways get crypto (13,654 IKEv1 / 5,136 IKEv2).
    Secrets not in the dump -> PSK/dyndns are shape-preserving fakes under
    ANONYMIZE, NULL for the real takeover (joined from the password store).
    `local_ts` is not in the source (every selector is a remote customer net) ->
    omitted for now (authored later; see the remote_ts/local_ts follow-up). A
    guard warns on any unexpected `IKEV2PROFILEID` (future custom profiles).

- **D. Gateways + real IPsec** from `RDRSROUTER` + `RDIPSECSPD2` +
  `RDSITE2ROUTER`/`RDSITEFROMSAP`; device->gateway from `RSROUTERID`.
- **E. Contracts (DONE).** Device `internal_use`/`dpa`/`dmy` from
  `RDCMDBCONTRACTFLAGS` + `RDSYSTEMDUMMYCONTRACT`, joined in `stage_devices` by
  **(model partno, raw serial)** -- a 0-conflict key (serial alone is ambiguous:
  60k serials have conflicting flags and device serials aren't unique). Uses the
  RAW serial so it survives ANONYMIZE. `CON_TC_WO_U_FLG`->`NIU` (precedence),
  else `CON_TC_FLG`->`STD`, else NULL; `CON_DPA_FLG`->`dpa`;
  `RDSYSTEMDUMMYCONTRACT` (SYSTEMID=device id, ISACTIVE=1)->`dmy`. Validated:
  148,039 dpa / 148,315 STD / 1,011 NIU / 753 dmy. Feeds the `systems:by-ip`
  aeroftp spool (docs/valkey_spool.md).
- **F. Service keys (DONE).** `device.service_key` / `service_key_level` /
  `service_key_expires` from `RDSERVICEKEY` (linked by `SERVICEDSYSID` = device
  id). Per device: the explicit `device.SERVICEKEYID` pointer if set, else the
  `ISDEFAULT=1` key (latest expiry wins). The key VALUE is a CREDENTIAL --
  **shape-preserving fake** under ANONYMIZE (`anonymize.fake_service_key`: short
  ~20-char HEX vs long ~335-char DASHED groups-of-5), kept in an IN-MEMORY-ONLY
  map (never written to a .map.json); level + expiry are non-secret (raw).
  Validated: 145,422 devices keyed (53,800 short / 91,622 long). Schema:
  `migrate_device_service_key.sql` (folded into schema_global.sql; runs BEFORE
  load.py). TODO: wire the value into the portal Connect tunnel request
  (`servicekey`).
  **Multi-key satellite (DONE):** `device_service_key` holds ALL of a device's
  keys (271,891 rows over 145,548 devices; `is_default` marks the one mirrored
  onto `device.service_key`). So the multi-key UI (list all / show expiry / flag
  default) is now a pure portal deploy -- no future DB change/reload.
- **G. Per-system app overrides (CORE + FULL DONE).** `stage_apps` populates
  `product_model_app` (model defaults) + `device_app` (per-device overrides). The legacy structure maps 1:1: every model has one app profile (via
  its devices' `APPPROFILEID`); the profile's `SYSTEMID=0` template rows are the
  model defaults, `SYSTEMID=<device>` rows are that device's full override.
  Application types normalized via `APP_MAP` to the 11 KEPT types
  (http/https/rdp/vnc/ssh/expert-i/teamviewer/transparent/scp/sftp/ftp); dropped
  types (ping/NetOp/Novius/X11 + all unused/obsolete incl. pcanywhere/netmeeting/
  timbuktu/telnet, which existed only as capability flags) are never imported.
  Validated: 5,273 model defaults + 114,791 device overrides (1,179 dropped-type
  rows removed). Schema: `migrate_device_app.sql` (device_app + resolve_apps +
  extended `application` enum; folded into schema_global.sql; runs BEFORE
  load.py). This pass imports **application + port + name**; PARAM MAPPING
  (sni/path/guac dims/credentials from `RDSERVAPPPROP`, 788k rows) is a
  deliberate SECOND PASS. TODO (portal): (a) device detail should call
  `resolve_apps(device)` so per-device overrides show (it reads
  `product_model_app` directly today); (b) the `AppEditor` application dropdown
  needs the 5 new types.
  **G-full (param pass, DONE):** from `RDSERVAPPPROP` (survey per app type: most
  fields are uniform/empty legacy-client cruft). Kept mappings only --
  `path` <- Homepage File (http/https, incl. legacy dana/ URLs); TCP extra ports
  (https Extra TCP Ports / transparent TCP Ports) folded into the comma-list
  `ports` (the gateway `ports` claim + client `parse_ports` already do multi-port
  TCP forwards; **no UDP in the gateway** so UDP ports go to `params.udp_ports`
  for later); teamviewer Options stored verbatim in `params.options` (the app is
  not modelled yet). Dropped: preferred browser, ALL rdp/vnc/ssh cosmetics,
  expert-i resolution (pending a query-param answer), scp/sftp/ftp. New `params`
  jsonb column on both app tables. No secrets in the props (credentials are
  PASSWORDID refs, separate). SNI is not stored per-app in the legacy -> default.
- **H. Users + PII (DONE -- Option 1, correct identity model).** Each `RDUSER` is
  a HUMAN, so `stage_users` now emits a **`login_account`** (the person: name,
  email, **phone/mobile/company** PII, `account_state`/`user_type`/
  `account_expires`) **+** a 1:1 **`app_user` persona** (the 'hat': name +
  optional contact email + DTM `country`) **+** an **`account_persona`** link
  (`is_primary`). PII lives on the ACCOUNT, not the persona. phone/mobile faked
  via `phone_lbl`, company via `company_lbl`; username/email guaranteed UNIQUE
  (`u<id>` / `user<n>@example.test` under ANONYMIZE, with dedup). Properties from
  `RDUSERPROPERTY` (User Type from GAMA / CompanyName / ExpirationDate). Imported
  accounts have NULL `password_hash` (cannot password-login; real auth = IdP
  later). Validated: 7,747 accounts + personas + links, all unique. Schema:
  `migrate_user_pii.sql` (LOCAL; login_account columns; runs BEFORE load.py).
  **The ~20 dev test logins (`seed_login_accounts.mjs`) + 6 test personas are
  preserved** -- they use distinct usernames/ids and are (re)created AFTER
  load.py. TODO: surface the account PII in the Administration > Accounts page.

## 4. Open decisions (need owner input)

1. Migrate the importer WholeSale to `second_load`, or cherry-pick tables while
   keeping the rest of the first export? (Recommend: migrate, since the device +
   grant shapes differ; keep DTM/classification Excel-sourced.)
2. Gz-compress the large new files (keep one `read()`), or add an uncompressed
   `read2()`?
3. Slice order to implement first (A+B+C core recommended).

## 5. UI / schema follow-ups (do not forget)

- **Service keys -- multi-key UI (Slice F follow-up).** A device has MANY service
  keys, not one. The import stores a single chosen value today, but the device
  UI must be reworked to: list all of a device's keys, show each key's EXPIRY,
  and let an operator flag exactly one as the DEFAULT. This implies keeping the
  full key set (a `device_service_key` satellite table), not just the one
  `device.service_key` column. Also still open: wire the (default) key into the
  portal Connect tunnel request (`servicekey`).
- **Gateway has BOTH `region` and `country` -- needs discussion.** `RDRSROUTER`
  gives a `REGIONID` (-> `region` name + `region_path`) AND a separate
  `COUNTRYID` (-> `country`). Region is the authz dimension; country is a
  denormalized scalar. Decide WHY both exist / whether `country` should just be
  derived from the region's country ancestor (like `device.country_iso`) rather
  than stored independently -- and reconcile if they ever disagree.
- **Gateway tunnel rules: split into `remote_ts` and `local_ts`.** The IPsec
  traffic selectors are currently modelled as a single `remote_ts[]` in the
  SiteRecord. They must become TWO columns/arrays -- `remote_ts` (the customer/
  device side) AND `local_ts` (our side) -- both for the schema/editor and the
  `fleetipsec:site` spool. Fold this into Slice D2 (real IPsec import) and the
  `IpsecEditor` UI.
