-- migrate_services_authz.sql  (GLOBAL plane: fleetshell)
--
-- The Services catalog + its authorization type. A "service" is a portal
-- FUNCTION (Screen Recording, File Transfer, Remote Assist, ...) arranged as an
-- ltree tree, exactly like region/product. Grants scope over service SUBTREES,
-- so a grant on `root.remote_access` entitles every function beneath it and a
-- leaf grant narrows to one.
--
-- This is a FEATURE ENTITLEMENT ("may this persona use Screen Recording at
-- all"), orthogonal to the device scope ("for WHICH devices") and to any future
-- data-class / PHI clearance layer. A gated function ANDs the two independent
-- checks: authz_can_service(groups,'view',<fn>) AND authz_can(groups,'view',dev).
--
-- Idempotent. Apply AFTER migrate_authz_catalog.sql (needs authz_effective_scopes
-- from authz_fastpath.sql):
--   psql "$GLOBAL_WRITER_URL" -f migrate_services_authz.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Vocabulary: the 'service' resource type + CRUD verbs. A service function is
--    a normal thing -- plain CRUD suffices; the recording browser gates on
--    service:view. (No bespoke action verb.)
-- ---------------------------------------------------------------------------
INSERT INTO authz_resource_type (key, description)
VALUES ('service', 'Portal service functions (Screen Recording, File Transfer, ...)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO authz_privilege (resource_type, verb)
SELECT 'service', v.vb
FROM (VALUES ('create'),('view'),('edit'),('delete')) AS v(vb)
ON CONFLICT (resource_type, verb) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The service catalog tree (id-based rows, readable ltree labels for the
--    seeded nodes; a stable `key` lets code reference a specific function).
--    User-added nodes (via the tree editor) get uuid-derived labels + NULL key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service (
    id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    path ltree NOT NULL,
    kind text  NOT NULL DEFAULT 'service'
         CHECK (kind IN ('root','category','service')),
    key  text UNIQUE,                        -- stable machine key (seeded nodes)
    name text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_service_path ON service USING gist (path);

-- Seed the agreed catalog. Safe to re-run: keyed on the stable ltree label.
INSERT INTO service (path, kind, key, name) VALUES
    ('root',                                    'root',     'root',              'Services'),
    ('root.global_services',                    'category', 'global_services',    'Global Services'),
    ('root.global_services.portal_news',        'service',  'portal_news',        'Portal News'),
    ('root.remote_access',                      'category', 'remote_access',      'Remote Access'),
    ('root.remote_access.remote_assist',        'service',  'remote_assist',      'Remote Assist'),
    ('root.remote_access.remote_control',       'service',  'remote_control',     'Remote Access'),
    ('root.remote_access.screen_recording',     'service',  'screen_recording',   'Screen Recording'),
    ('root.data_transfer',                      'category', 'data_transfer',      'Data Transfer'),
    ('root.data_transfer.file_transfer',        'service',  'file_transfer',      'File Transfer'),
    ('root.data_transfer.streaming',            'service',  'streaming',          'Streaming'),
    ('root.data_transfer.data_collection',      'service',  'data_collection',    'Data Collection'),
    ('root.software_distribution',              'category', 'software_distribution', 'Software Distribution'),
    ('root.software_distribution.packaging',    'service',  'packaging',          'Packaging'),
    ('root.software_distribution.order_mgmt',   'service',  'order_management',   'Order Management'),
    ('root.software_distribution.distribution', 'service',  'distribution',       'Distribution')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Resolution: the ltree-scoped point check + a coarse capability check.
--    Mirrors authz_can (device) but over the generic service_path dimension.
-- ---------------------------------------------------------------------------

-- Does the persona hold a grant of (verb, resource_type) at all, ignoring the
-- scope? A coarse capability gate for types with no meaningful scope dimension.
CREATE OR REPLACE FUNCTION authz_has(
    p_group_ids uuid[], p_resource_type text, p_verb text
) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM authz_effective_scopes(p_group_ids, p_resource_type, p_verb)
    );
$$;

-- Point check: may the groups `verb` the service at p_service_path? An attribute
-- scope with NO service_path constraint is a full wildcard (matches every
-- function); a scope with service_path constraint(s) matches when the target is
-- within ANY of the constrained subtrees (target <@ constrained_path).
CREATE OR REPLACE FUNCTION authz_can_service(
    p_group_ids uuid[], p_verb text, p_service_path ltree
) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM authz_effective_scopes(p_group_ids, 'service', p_verb) es
        WHERE es.kind = 'attribute'
          AND (
              NOT EXISTS (
                  SELECT 1 FROM authz_scope_constraint c
                  WHERE c.scope_id = es.scope_id AND c.dimension = 'service_path'
              )
              OR EXISTS (
                  SELECT 1 FROM authz_scope_constraint c
                  WHERE c.scope_id = es.scope_id AND c.dimension = 'service_path'
                    AND p_service_path <@ ANY(c.values::ltree[])
              )
          )
    );
$$;

-- Convenience: resolve a service node's path from its stable key, for callers
-- that gate on a well-known function (e.g. 'screen_recording').
CREATE OR REPLACE FUNCTION authz_can_service_key(
    p_group_ids uuid[], p_verb text, p_service_key text
) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT authz_can_service(
        p_group_ids, p_verb,
        (SELECT path FROM service WHERE key = p_service_key)
    );
$$;

COMMIT;
