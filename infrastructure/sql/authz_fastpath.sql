-- authz_fastpath.sql  (GLOBAL plane: fleetshell)
--
-- Index-using replacements for authz_list_devices / authz_can. The reference
-- authz_device_in_scope() is a per-row black box, so the planner seq-scans all
-- devices and calls it once per (device x scope) -- O(192k x 248) = minutes.
--
-- Here we PIVOT each effective scope into its dimensions, then drive the query
-- as index nested-loops: for each scope, look devices up via the GiST index on
-- region_path/product_path (op <@) or the btree on customer_id/site_id. The
-- disjunction over scopes becomes a UNION of index scans, partitioned by scope
-- SHAPE so every branch has a concrete, indexable primary condition.
--
-- Apply AFTER authz_resolve.sql:  psql "$GW" -f authz_fastpath.sql

BEGIN;

-- Scope resolution, GROUP-FIRST. The reference authz_effective_scopes expands
-- every system-wide grant with a matching role, then filters to the user's
-- groups (~62k rows, ~193k buffers). Here we start from the user's groups (+ any
-- ancestors via the ltree path), then fetch only THEIR grants -> a few hundred
-- rows. Same result, orders of magnitude cheaper.
CREATE OR REPLACE FUNCTION authz_effective_scopes(
    p_group_ids uuid[], p_resource_type text, p_verb text
) RETURNS TABLE(scope_id uuid, kind text)
LANGUAGE sql STABLE AS $$
    WITH my_groups AS (
        SELECT DISTINCT gg.group_id
        FROM principal_group ug
        JOIN principal_group gg
          ON gg.path @> ug.path OR gg.group_id = ug.group_id   -- self + ancestors
        WHERE ug.group_id = ANY(p_group_ids)
    )
    SELECT DISTINCT g.scope_id, s.kind
    FROM my_groups mg
    JOIN authz_grant g           ON g.group_id = mg.group_id
    JOIN authz_scope s           ON s.id = g.scope_id AND s.resource_type = p_resource_type
    JOIN authz_role_privilege rp ON rp.role_id = g.role_id
    JOIN authz_privilege p       ON p.id = rp.privilege_id
                                AND p.resource_type = p_resource_type
                                AND p.verb = p_verb;
$$;

-- Pivot: one row per effective scope with its (nullable) dimensions.
CREATE OR REPLACE FUNCTION authz_effective_scope_rows(
    p_group_ids uuid[], p_resource_type text, p_verb text
) RETURNS TABLE(scope_id uuid, kind text,
                region_path ltree, product_path ltree,
                customer_id uuid, site_id uuid)
LANGUAGE sql STABLE AS $$
    SELECT es.scope_id, es.kind,
        (max(c.values[1]) FILTER (WHERE c.dimension = 'region_path'))::ltree,
        (max(c.values[1]) FILTER (WHERE c.dimension = 'product_path'))::ltree,
        (max(c.values[1]) FILTER (WHERE c.dimension = 'customer_id'))::uuid,
        (max(c.values[1]) FILTER (WHERE c.dimension = 'site_id'))::uuid
    FROM authz_effective_scopes(p_group_ids, p_resource_type, p_verb) es
    LEFT JOIN authz_scope_constraint c ON c.scope_id = es.scope_id
    GROUP BY es.scope_id, es.kind;
$$;

-- The visible device-id set for a verb, as a UNION of per-shape index scans.
-- gating: an attribute scope reaches access_requirement 'open' always, and
-- 'customer'/'site' only when the scope actually names that dimension.
-- Collapses same-SHAPE single-dimension scopes into ONE array scan so each
-- device block is touched ~once (a BitmapOr over the GiST index, or one seq
-- scan worst case) instead of once PER scope. True multi-dimension scopes stay
-- per-scope (they are few and selective).
CREATE OR REPLACE FUNCTION authz_visible_device_ids(
    p_group_ids uuid[], p_verb text
) RETURNS TABLE(id uuid)
LANGUAGE sql STABLE AS $$
    WITH es AS (
        SELECT * FROM authz_effective_scope_rows(p_group_ids, 'device', p_verb)
    ),
    -- aggregated paths/ids for the four single-dimension shapes
    ro AS (SELECT array_agg(region_path)  AS a FROM es
            WHERE kind='attribute' AND region_path IS NOT NULL
              AND product_path IS NULL AND customer_id IS NULL AND site_id IS NULL),
    po AS (SELECT array_agg(product_path) AS a FROM es
            WHERE kind='attribute' AND product_path IS NOT NULL
              AND region_path IS NULL AND customer_id IS NULL AND site_id IS NULL),
    co AS (SELECT array_agg(customer_id)  AS a FROM es
            WHERE kind='attribute' AND customer_id IS NOT NULL
              AND region_path IS NULL AND product_path IS NULL AND site_id IS NULL),
    so AS (SELECT array_agg(site_id)      AS a FROM es
            WHERE kind='attribute' AND site_id IS NOT NULL
              AND region_path IS NULL AND product_path IS NULL AND customer_id IS NULL)
    -- region-only (collapsed)
    SELECT d.id FROM device d, ro
     WHERE ro.a IS NOT NULL AND d.access_requirement = 'open'
       AND d.region_path <@ ANY(ro.a)
    UNION
    -- product-only (collapsed)
    SELECT d.id FROM device d, po
     WHERE po.a IS NOT NULL AND d.access_requirement = 'open'
       AND d.product_path <@ ANY(po.a)
    UNION
    -- customer-only (collapsed)
    SELECT d.id FROM device d, co
     WHERE co.a IS NOT NULL AND d.access_requirement IN ('open','customer')
       AND d.customer_id = ANY(co.a)
    UNION
    -- site-only (collapsed)
    SELECT d.id FROM device d, so
     WHERE so.a IS NOT NULL AND d.access_requirement IN ('open','site')
       AND d.site_id = ANY(so.a)
    UNION
    -- multi-dimension scopes with a region constraint (region primary, GiST)
    SELECT d.id FROM es JOIN device d ON d.region_path <@ es.region_path
     WHERE es.kind='attribute' AND es.region_path IS NOT NULL
       AND (es.product_path IS NOT NULL OR es.customer_id IS NOT NULL OR es.site_id IS NOT NULL)
       AND (es.product_path IS NULL OR d.product_path <@ es.product_path)
       AND (es.customer_id  IS NULL OR d.customer_id = es.customer_id)
       AND (es.site_id      IS NULL OR d.site_id = es.site_id)
       AND (d.access_requirement = 'open'
            OR (d.access_requirement = 'customer' AND es.customer_id IS NOT NULL)
            OR (d.access_requirement = 'site'     AND es.site_id IS NOT NULL))
    UNION
    -- multi-dimension scopes, region NULL, product present (product primary)
    SELECT d.id FROM es JOIN device d ON d.product_path <@ es.product_path
     WHERE es.kind='attribute' AND es.region_path IS NULL AND es.product_path IS NOT NULL
       AND (es.customer_id IS NOT NULL OR es.site_id IS NOT NULL)
       AND (es.customer_id IS NULL OR d.customer_id = es.customer_id)
       AND (es.site_id     IS NULL OR d.site_id = es.site_id)
       AND (d.access_requirement = 'open'
            OR (d.access_requirement = 'customer' AND es.customer_id IS NOT NULL)
            OR (d.access_requirement = 'site'     AND es.site_id IS NOT NULL))
    UNION
    -- multi-dimension scopes with only customer+site (region+product NULL)
    SELECT d.id FROM es JOIN device d ON d.customer_id = es.customer_id
     WHERE es.kind='attribute' AND es.region_path IS NULL AND es.product_path IS NULL
       AND es.customer_id IS NOT NULL AND es.site_id IS NOT NULL
       AND d.site_id = es.site_id
       AND d.access_requirement IN ('open','customer','site')
    UNION
    -- full-wildcard attribute scope (no constraints) -> all open devices
    SELECT d.id FROM device d
     WHERE d.access_requirement = 'open'
       AND EXISTS (SELECT 1 FROM es WHERE es.kind = 'attribute'
                   AND es.region_path IS NULL AND es.product_path IS NULL
                   AND es.customer_id IS NULL AND es.site_id IS NULL)
    UNION
    -- single_system (explicit id list) -> reaches any access_requirement
    SELECT sd.device_id FROM es
     JOIN authz_scope_device sd ON sd.scope_id = es.scope_id
     WHERE es.kind = 'single_system';
$$;

-- LIST: keyset-paginated devices, joining the visible-id set.
CREATE OR REPLACE FUNCTION authz_list_devices(
    p_group_ids     uuid[],
    p_verb          text,
    p_after_updated timestamptz DEFAULT NULL,
    p_after_id      uuid        DEFAULT NULL,
    p_limit         int         DEFAULT 50
) RETURNS SETOF device
LANGUAGE sql STABLE AS $$
    SELECT d.*
    FROM device d
    JOIN authz_visible_device_ids(p_group_ids, p_verb) v ON v.id = d.id
    WHERE (p_after_updated IS NULL
           OR (d.updated_at, d.id) < (p_after_updated, p_after_id))
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT p_limit;
$$;

-- CHECK: fetch the single device by PK first, then test the small pivoted scope
-- set against it (no fleet scan).
CREATE OR REPLACE FUNCTION authz_can(
    p_group_ids uuid[], p_verb text, p_device_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
    d  device%ROWTYPE;
    ok boolean;
BEGIN
    SELECT * INTO d FROM device WHERE id = p_device_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    SELECT EXISTS (
        SELECT 1
        FROM authz_effective_scope_rows(p_group_ids, 'device', p_verb) es
        WHERE (es.kind = 'single_system' AND EXISTS (
                   SELECT 1 FROM authz_scope_device sd
                   WHERE sd.scope_id = es.scope_id AND sd.device_id = d.id))
            OR (es.kind = 'attribute'
                AND (es.region_path  IS NULL OR d.region_path <@ es.region_path)
                AND (es.product_path IS NULL OR d.product_path <@ es.product_path)
                AND (es.customer_id  IS NULL OR d.customer_id = es.customer_id)
                AND (es.site_id      IS NULL OR d.site_id = es.site_id)
                AND (d.access_requirement = 'open'
                     OR (d.access_requirement = 'customer' AND es.customer_id IS NOT NULL)
                     OR (d.access_requirement = 'site'     AND es.site_id IS NOT NULL)))
    ) INTO ok;
    RETURN ok;
END;
$$;

-- Give the list path enough memory to sort/dedup the visible set in RAM (avoids
-- the temp spill seen at low ACU). Applies for the duration of the call,
-- including the nested authz_visible_device_ids.
ALTER FUNCTION authz_visible_device_ids(uuid[], text) SET work_mem = '128MB';
ALTER FUNCTION authz_list_devices(uuid[], text, timestamptz, uuid, integer) SET work_mem = '128MB';

-- ---------------------------------------------------------------------------
-- GATEWAY authorization (mirrors the device fast path; region-subtree only).
-- Gateways have no product/customer/site/single_system/access_requirement, so
-- the visible set is region-subtree scopes UNION the full-wildcard scope.
-- Full detail + the region_path backfill live in migrate_gateway_authz.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION authz_visible_gateway_ids(
    p_group_ids uuid[], p_verb text
) RETURNS TABLE(id uuid)
LANGUAGE sql STABLE AS $$
    WITH es AS (
        SELECT * FROM authz_effective_scope_rows(p_group_ids, 'gateway', p_verb)
    ),
    ro AS (SELECT array_agg(region_path) AS a FROM es
            WHERE kind='attribute' AND region_path IS NOT NULL
              AND product_path IS NULL AND customer_id IS NULL AND site_id IS NULL)
    SELECT g.id FROM gateway g, ro
     WHERE ro.a IS NOT NULL AND g.region_path IS NOT NULL
       AND g.region_path <@ ANY(ro.a)
    UNION
    SELECT g.id FROM gateway g
     WHERE EXISTS (SELECT 1 FROM es WHERE kind='attribute'
                   AND region_path IS NULL AND product_path IS NULL
                   AND customer_id IS NULL AND site_id IS NULL);
$$;

CREATE OR REPLACE FUNCTION authz_list_gateways(
    p_group_ids uuid[], p_verb text,
    p_after_id  uuid DEFAULT NULL, p_limit int DEFAULT 50
) RETURNS SETOF gateway
LANGUAGE sql STABLE AS $$
    SELECT g.*
    FROM gateway g
    JOIN authz_visible_gateway_ids(p_group_ids, p_verb) v ON v.id = g.id
    WHERE (p_after_id IS NULL OR g.id > p_after_id)
    ORDER BY g.id
    LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION authz_can_gateway(
    p_group_ids uuid[], p_verb text, p_gateway_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
    gw gateway%ROWTYPE;
    ok boolean;
BEGIN
    SELECT * INTO gw FROM gateway WHERE id = p_gateway_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    SELECT EXISTS (
        SELECT 1
        FROM authz_effective_scope_rows(p_group_ids, 'gateway', p_verb) es
        WHERE es.kind = 'attribute'
          AND es.product_path IS NULL AND es.customer_id IS NULL AND es.site_id IS NULL
          AND (es.region_path IS NULL
               OR (gw.region_path IS NOT NULL AND gw.region_path <@ es.region_path))
    ) INTO ok;
    RETURN ok;
END;
$$;

COMMIT;
