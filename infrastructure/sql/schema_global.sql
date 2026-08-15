-- schema_global.sql
--
-- GLOBAL data plane (Aurora Global Database, primary = eu-west-2).
-- Holds everything that must be readable worldwide: master data + the
-- polymorphic authorization model. NO user PII and NO group membership live
-- here (those are regional -- see schema_local.sql).
--
-- Design summary (the "everything is a thing" model):
--   * A THING has a resource_type, attributes, and optionally a position in a
--     hierarchy (ltree path).
--   * A SET OF THINGS is a scope of one of two kinds: an ATTRIBUTE predicate
--     over one resource_type's attribute space (omitted dimension = wildcard,
--     and explicit_grant_only devices excluded), or a SINGLE_SYSTEM explicit
--     id list (the only way to reach explicit_grant_only devices).
--   * A GRANT authorizes (who = group, what = role -> privileges,
--     where = scope) over things of a resource_type.
--   * Privileges are typed (verb + resource_type); roles bundle them freely.
--
-- Apply with:  psql "$GLOBAL_WRITER_URL" -f schema_global.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS ltree;      -- hierarchical paths (product tree, sites, group nesting)
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(); app SHOULD supply UUIDv7 for time-ordering

-- ===========================================================================
-- 1. Authorization vocabulary
-- ===========================================================================

-- The set of thing-types the authz model can talk about.
CREATE TABLE IF NOT EXISTS authz_resource_type (
    key         text PRIMARY KEY,          -- 'device','gateway','group','product','customer','site','grant',...
    description text NOT NULL DEFAULT ''
);

-- A privilege is a (verb, resource_type) pair: the atomic capability.
CREATE TABLE IF NOT EXISTS authz_privilege (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type text NOT NULL REFERENCES authz_resource_type(key),
    verb          text NOT NULL,           -- 'view','edit','connect','create','add_member','maintain',...
    UNIQUE (resource_type, verb)
);

-- A role bundles privileges (possibly across resource types).
CREATE TABLE IF NOT EXISTS authz_role (
    id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key   text UNIQUE NOT NULL,            -- stable machine key, e.g. 'group_admin'
    name  text NOT NULL
);

CREATE TABLE IF NOT EXISTS authz_role_privilege (
    role_id      uuid NOT NULL REFERENCES authz_role(id) ON DELETE CASCADE,
    privilege_id uuid NOT NULL REFERENCES authz_privilege(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, privilege_id)
);

-- ===========================================================================
-- 2. Scopes -- the "where": a set of things defined by a predicate
-- ===========================================================================

-- A scope is typed (resource_type) AND has a kind:
--   'attribute'     -> device set defined by the constraints below (omitted
--                      dimension = wildcard); implicitly EXCLUDES devices
--                      flagged device.explicit_grant_only.
--   'single_system' -> device set is the explicit id list in authz_scope_device;
--                      CAN reach explicit_grant_only devices.
CREATE TABLE IF NOT EXISTS authz_scope (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type text NOT NULL REFERENCES authz_resource_type(key),
    kind          text NOT NULL DEFAULT 'attribute'
                  CHECK (kind IN ('attribute','single_system')),
    label         text NOT NULL DEFAULT ''  -- human hint, e.g. 'CT in DE'
);

-- Each constraint narrows one dimension of the resource_type's attribute space.
-- ABSENCE of a constraint for a dimension = wildcard (%any).
-- A scope's predicate = AND over all its constraints.
CREATE TABLE IF NOT EXISTS authz_scope_constraint (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id  uuid NOT NULL REFERENCES authz_scope(id) ON DELETE CASCADE,
    dimension text NOT NULL,               -- 'country','modality','product_path','software_version',...
    op        text NOT NULL CHECK (op IN ('in','subtree','eq','gt','ge','lt','le','between')),
    values    text[] NOT NULL              -- 'in' -> set; 'subtree' -> ltree path(s); 'between' -> {lo,hi}
);
CREATE INDEX IF NOT EXISTS ix_scope_constraint_scope ON authz_scope_constraint(scope_id);

-- Single-system scope: an explicit device-id list. This is the ONLY way to
-- reach devices flagged device.explicit_grant_only -- wildcard/attribute grants
-- deliberately miss them (military hospitals, etc.).
-- (Service domains / nested named sets were dropped: the two live instances
-- decompose into plain attribute scopes.)
CREATE TABLE IF NOT EXISTS authz_scope_device (
    scope_id  uuid NOT NULL REFERENCES authz_scope(id) ON DELETE CASCADE,
    device_id uuid NOT NULL,                -- -> device.id (same global plane)
    PRIMARY KEY (scope_id, device_id)
);
CREATE INDEX IF NOT EXISTS ix_scope_device_device ON authz_scope_device(device_id);

-- ===========================================================================
-- 3. Principals (thin GLOBAL group registry) + grants
-- ===========================================================================

-- Groups EXIST globally so grants can reference them; their MEMBERS live
-- regionally (schema_local.group_membership). Only non-PII metadata here.
-- GRANT INHERITANCE: a grant on a group applies to all DESCENDANT groups.
-- Resolve via the ltree path -- a user's effective grants = grants on the
-- user's groups PLUS grants on any ANCESTOR (grant.group.path @> user_group.path).
-- Depth <= 5 (root.CCC.CCC_DE.CCC_DE_military ...), so this is a single indexed
-- GiST lookup: no closure table, no recursive CTE needed.
CREATE TABLE IF NOT EXISTS principal_group (
    group_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    home_region text NOT NULL,             -- where this group's membership + PII resolve
    label       text NOT NULL,             -- non-PII, e.g. 'CT Admins Germany'
    path        ltree,                     -- optional global group nesting
    parent_id   uuid REFERENCES principal_group(group_id)
);
CREATE INDEX IF NOT EXISTS ix_group_path ON principal_group USING gist (path);

-- The grant: who (group) x what (role) x where (scope).
CREATE TABLE IF NOT EXISTS authz_grant (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id   uuid NOT NULL REFERENCES principal_group(group_id) ON DELETE CASCADE,
    role_id    uuid NOT NULL REFERENCES authz_role(id),
    scope_id   uuid NOT NULL REFERENCES authz_scope(id),
    created_by uuid,                        -- opaque user_id (audit; pseudonymous)
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Denormalized projection for grant-on-grant (delegated admin) authz:
    -- lets a scope over resource_type='grant' test a proposed grant's shape.
    grant_resource_type text,               -- the scope's resource_type
    grant_verbs         text[]              -- verbs the role confers (for "can't escalate" checks)
);
CREATE INDEX IF NOT EXISTS ix_grant_group ON authz_grant(group_id);
CREATE INDEX IF NOT EXISTS ix_grant_role  ON authz_grant(role_id);
CREATE INDEX IF NOT EXISTS ix_grant_scope ON authz_grant(scope_id);

-- ===========================================================================
-- 4. Master data (the high-cardinality things)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS gateway (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hostname  text,                        -- DynDNS hostname (dynamic-IP gateways); NULL for static-IP
    region    text NOT NULL,               -- which regional VPC it lives in (REGIONNAME)
    hospital  text NOT NULL DEFAULT '',    -- anonymized customer/hospital (IDENTIFIER2; shared map)
    -- RS-router (communication interface) detail, from RDRSROUTERDETAILVIEWV1:
    name              text,                -- NAME (router id / cisco serial) -- RAW
    city              text,                -- IDENTIFIER1 (anonymized; shared map with device city)
    gateway_model     text,                -- DISPLAYROUTERTYPE (e.g. 'Cisco 867VAE-K9'; 'undefined' -> NULL)
    connection_type   text,                -- CONNECTIONTYPE decoded (e.g. 'Internet with IPSec')
    operational_state text,                -- OPERATIONALSTATE decoded (e.g. 'Access Allowed')
    static_ip         text,                -- STATICIP
    nat_type          text,                -- NATTYPE
    admin_ip          text,                -- IPADDRESSADM1 (anonymized)
    admin_ip2         text,                -- IPADDRESSADM2 (anonymized)
    country           text,                -- COUNTRYNAME
    -- IPsec tunnel / crypto: the operational connection data (authored in the UI,
    -- spooled to Valkey fleetipsec:* keyed by public_ip). See fleetshell-portal
    -- src/lib/server/gateways.ts (SiteRecord). Not imported from the legacy CSV.
    public_ip         text,                -- external tunnel endpoint IP (Valkey key)
    psk               text,                -- IPsec pre-shared key
    ipsec             jsonb                -- SiteRecord: { ike_version, ike_identity, static_ip,
                                           --   dyndns_password, ike_enc[], ike_auth[], ike_dh[],
                                           --   esp_enc[], esp_auth[], esp_pfs[], remote_ts[] }
);
CREATE INDEX IF NOT EXISTS ix_gateway_publicip_trgm ON gateway USING gin (public_ip gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_gateway_name_trgm     ON gateway USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_gateway_hospital_trgm ON gateway USING gin (hospital gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_gateway_city_trgm     ON gateway USING gin (city gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_gateway_adminip_trgm  ON gateway USING gin (admin_ip gin_trgm_ops);

CREATE TABLE IF NOT EXISTS customer (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    country text NOT NULL,
    name    text NOT NULL,
    requires_explicit_grant boolean NOT NULL DEFAULT false  -- devices need an explicit customer grant
);

-- A customer_site is a NAMED device set: static list UNION dynamic filter.
CREATE TABLE IF NOT EXISTS customer_site (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
    country         text NOT NULL,
    name            text NOT NULL,
    requires_explicit_grant boolean NOT NULL DEFAULT false, -- devices need an explicit site grant
    membership_kind text NOT NULL DEFAULT 'static'
                    CHECK (membership_kind IN ('static','dynamic','mixed'))
);

-- The geographic hierarchy: World > Region > Country > State, as an ID-based
-- ltree. Merges the legacy country + region tables. Grants scope by SUBTREE.
CREATE TABLE IF NOT EXISTS region (
    id        bigint PRIMARY KEY,
    path      ltree  NOT NULL,
    name      text   NOT NULL,
    iso       text,
    level     int    NOT NULL,
    parent_id bigint REFERENCES region(id)
);
CREATE INDEX IF NOT EXISTS ix_region_path ON region USING gist (path);

-- The product tree (modality -> product -> model) as an ltree. The rich
-- per-model attributes (partno, serial range, host flag, apps) live on the
-- model level in the satellites below, NOT on this shared node -- see
-- docs/product_admin.md.
CREATE TABLE IF NOT EXISTS product (
    id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    path   ltree NOT NULL,                 -- id-based: modality.product.model
    kind   text  NOT NULL DEFAULT 'product' -- level discriminator
           CHECK (kind IN ('modality','product','model')),
    family text,                           -- only meaningful on kind='product'
    name   text  NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_product_path ON product USING gist (path);
CREATE INDEX IF NOT EXISTS ix_product_kind ON product(kind);

-- Model-level typed attributes (1:1 with a kind='model' product node).
CREATE TABLE IF NOT EXISTS product_model (
    product_id       uuid PRIMARY KEY REFERENCES product(id) ON DELETE CASCADE,
    partno           bigint,
    serial_from      bigint,               -- inclusive lower bound (integer serials)
    serial_to        bigint,               -- inclusive upper bound
    is_host_computer boolean NOT NULL DEFAULT false
);

-- The Connect-application defaults for a model. Column-for-column identical to
-- the client AppProfile (fleetshell-portal .../devices) so one editor component
-- serves both the product-model page and the device page. Devices inherit these
-- live unless they carry their own override rows (device_app, defined later).
CREATE TABLE IF NOT EXISTS product_model_app (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,  -- the model node
    name        text NOT NULL,
    application text NOT NULL
                CHECK (application IN ('http','https','expert-i','rdp','vnc','ssh')),
    ports       text NOT NULL DEFAULT '',   -- '3389' or a range like '3000-3020'
    guac        boolean NOT NULL DEFAULT false,
    e2ecrypt    boolean NOT NULL DEFAULT false,
    sni         text NOT NULL DEFAULT '',
    path        text NOT NULL DEFAULT '/',
    width       int  NOT NULL DEFAULT 1920,
    height      int  NOT NULL DEFAULT 1080,
    dpi         int  NOT NULL DEFAULT 96,
    drive       boolean NOT NULL DEFAULT false,
    record      boolean NOT NULL DEFAULT false,
    sort_order  int  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_product_model_app_product ON product_model_app(product_id);

-- Devices: scope dimensions promoted to indexed columns; long tail in jsonb.
CREATE TABLE IF NOT EXISTS device (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_path        ltree,             -- position in the region hierarchy
    country_iso        text,              -- denormalized country code (display/filter)
    modality           text,              -- 'CT','MR',...
    product_path       ltree,             -- position in the product tree
    customer_id        uuid REFERENCES customer(id) ON DELETE SET NULL,        -- NULL = flat (no customer)
    site_id            uuid REFERENCES customer_site(id) ON DELETE SET NULL,   -- materialized from site rules
    gateway_id         uuid REFERENCES gateway(id),
    hospital_name      text,
    software_version   text,
    -- graded explicit-access requirement (open|device|customer|site); an
    -- attribute grant reaches only 'open', a single_system grant reaches
    -- 'device', and 'customer'/'site' need a grant that names that dimension.
    access_requirement text NOT NULL DEFAULT 'open'
                       CHECK (access_requirement IN ('open','device','customer','site')),
    -- device-identity fields (searchable; anonymized in the dev dump)
    serial             text,              -- SERIAL
    functional_location text,             -- IDENTIFIER3 (NNN-NNNNNN)
    technical_ident    text,              -- SYSTEMID2 ("Technical Ident")
    host_hw_id         text,              -- HOSTID ("Host/Hardware ID")
    order_number       text,              -- ORDERNO
    ip_address         text,              -- IPADDRESS1 (primary)
    ip_real            text,              -- REALIPADDRESS (secondary)
    contact            text,              -- CONTACT (PII; anonymized)
    city               text,              -- CITY (anonymized; shared map with gateway city)
    attrs              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- extensible dimensions
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_device_region_path ON device USING gist (region_path);
CREATE INDEX IF NOT EXISTS ix_device_country_iso ON device(country_iso);
CREATE INDEX IF NOT EXISTS ix_device_modality     ON device(modality);
CREATE INDEX IF NOT EXISTS ix_device_product_path ON device USING gist (product_path);
CREATE INDEX IF NOT EXISTS ix_device_customer     ON device(customer_id);
CREATE INDEX IF NOT EXISTS ix_device_site         ON device(site_id);
CREATE INDEX IF NOT EXISTS ix_device_gateway      ON device(gateway_id);
CREATE INDEX IF NOT EXISTS ix_device_attrs        ON device USING gin (attrs);
-- Trigram indexes for the Google-style device search (serial / FL / IP / etc.).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_device_serial_trgm   ON device USING gin (serial gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_fl_trgm       ON device USING gin (functional_location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_ip_trgm       ON device USING gin (ip_address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_ipreal_trgm   ON device USING gin (ip_real gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_tid_trgm      ON device USING gin (technical_ident gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_host_trgm     ON device USING gin (host_hw_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_ordno_trgm    ON device USING gin (order_number gin_trgm_ops);

-- customer_site membership: the manual list and the dynamic-filter link.
CREATE TABLE IF NOT EXISTS customer_site_member_static (
    site_id   uuid NOT NULL REFERENCES customer_site(id) ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    PRIMARY KEY (site_id, device_id)
);

-- A site's DYNAMIC membership rule: a device joins the site when an attribute
-- matches (gateway_id or hospital_name). A background job resolves these rules
-- plus the static list into the materialized device.site_id column, so the hot
-- authz path reads one indexed column and never touches this table.
CREATE TABLE IF NOT EXISTS customer_site_rule (
    site_id   uuid NOT NULL REFERENCES customer_site(id) ON DELETE CASCADE,
    dimension text NOT NULL CHECK (dimension IN ('gateway_id','hospital_name')),
    values    text[] NOT NULL,
    PRIMARY KEY (site_id, dimension)
);

-- Org-wide application settings (admin-controlled), e.g. the default UI theme.
CREATE TABLE IF NOT EXISTS app_setting (
    key   text PRIMARY KEY,
    value text NOT NULL
);

-- ===========================================================================
-- 5. Seed the authorization vocabulary
-- ===========================================================================

INSERT INTO authz_resource_type (key, description) VALUES
    ('device',   'Managed field devices'),
    ('gateway',  'Regional tunnel gateways'),
    ('product',  'Product tree nodes'),
    ('customer', 'Customers'),
    ('site',     'Customer sites (named device sets)'),
    ('region',   'Region / country structure'),
    ('group',    'User groups'),
    ('role',     'Authorization roles'),
    ('grant',    'Authorization grants (delegated administration)'),
    ('account',  'Login accounts (the human who signs in)'),
    ('persona',  'Personas (the authorization subject)')
ON CONFLICT (key) DO NOTHING;

-- Canonical privilege catalog: fixed CRUD verbs on every type (types are
-- extensible -- add rows above as portal functions land) + the one action verb
-- device:connect. See migrate_authz_catalog.sql and docs/mdm_design.md.
INSERT INTO authz_privilege (resource_type, verb)
SELECT t.rt, v.vb
FROM (VALUES ('device'),('gateway'),('product'),('customer'),('site'),
             ('region'),('group'),('role'),('grant'),('account'),('persona')) AS t(rt)
CROSS JOIN (VALUES ('create'),('view'),('edit'),('delete')) AS v(vb)
ON CONFLICT (resource_type, verb) DO NOTHING;
INSERT INTO authz_privilege (resource_type, verb) VALUES ('device','connect')
ON CONFLICT (resource_type, verb) DO NOTHING;

INSERT INTO app_setting (key, value) VALUES ('default_theme', 'nucleus')
ON CONFLICT (key) DO NOTHING;

COMMIT;
