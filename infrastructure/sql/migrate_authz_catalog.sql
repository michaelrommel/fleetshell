-- migrate_authz_catalog.sql
--
-- Normalize the authorization vocabulary to the agreed model (see
-- docs/portal_ui.md / mdm_design.md):
--
--   * Types  = rows in authz_resource_type (EXTENSIBLE; add more as portal
--              functions land). Starting set = 11:
--              device, gateway, product, customer, site, region, group, role,
--              grant, account, persona.
--   * Verbs  = fixed CRUD (create, view, edit, delete) on every type, plus the
--              one action verb device:connect.
--
-- Replaces the ad-hoc imported catalog (product:maintain, group:add_member,
-- group:remove_member, ...) and remaps existing role bundles to the CRUD
-- equivalent. authz_grant is untouched (grants reference roles, not privileges),
-- so this only rewrites the small authz_privilege / authz_role_privilege tables.
--
--   psql "$GLOBAL_WRITER_URL" -f migrate_authz_catalog.sql

BEGIN;

-- 1. Resource types (idempotent; adds account + persona to the seeded set).
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

-- 2. Canonical privileges: CRUD on every type + the device:connect action.
INSERT INTO authz_privilege (resource_type, verb)
SELECT t.rt, v.vb
FROM (VALUES ('device'),('gateway'),('product'),('customer'),('site'),
             ('region'),('group'),('role'),('grant'),('account'),('persona')) AS t(rt)
CROSS JOIN (VALUES ('create'),('view'),('edit'),('delete')) AS v(vb)
ON CONFLICT (resource_type, verb) DO NOTHING;

INSERT INTO authz_privilege (resource_type, verb) VALUES ('device','connect')
ON CONFLICT (resource_type, verb) DO NOTHING;

-- 3. Remap legacy non-CRUD verbs on existing role bundles to the CRUD verb.
WITH remap(old_rt, old_vb, new_vb) AS (VALUES
    ('group',  'add_member',    'edit'),
    ('group',  'remove_member', 'edit'),
    ('product','maintain',      'edit')
)
INSERT INTO authz_role_privilege (role_id, privilege_id)
SELECT rp.role_id, np.id
FROM authz_role_privilege rp
JOIN authz_privilege op ON op.id = rp.privilege_id
JOIN remap r           ON r.old_rt = op.resource_type AND r.old_vb = op.verb
JOIN authz_privilege np ON np.resource_type = op.resource_type AND np.verb = r.new_vb
ON CONFLICT (role_id, privilege_id) DO NOTHING;

-- 4. Drop every non-canonical privilege (verb not CRUD, and not device:connect).
--    authz_role_privilege.privilege_id cascades, cleaning the remapped-away rows.
DELETE FROM authz_privilege p
WHERE p.verb NOT IN ('create','view','edit','delete')
  AND NOT (p.resource_type = 'device' AND p.verb = 'connect');

COMMIT;
