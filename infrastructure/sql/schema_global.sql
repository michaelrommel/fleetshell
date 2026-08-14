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
    dns_name  text UNIQUE NOT NULL,        -- e.g. 'us.gateway.fleetshell.com'
    region    text NOT NULL,               -- which regional VPC it lives in
    label     text NOT NULL DEFAULT ''
);

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

-- The product tree (CT -> models -> partno -> serial ranges) as an ltree.
CREATE TABLE IF NOT EXISTS product (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    path        ltree NOT NULL,            -- e.g. 'ct.somatom.force'
    partno      text,
    serial_from text,
    serial_to   text,
    name        text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_product_path ON product USING gist (path);

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
