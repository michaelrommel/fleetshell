-- authz_resolve.sql
--
-- Callable authorization resolution for the GLOBAL plane: turns
-- (user's group_ids, verb) into a check() and a paginated list().
-- Apply AFTER schema_global.sql:  psql "$GLOBAL_WRITER_URL" -f authz_resolve.sql
--
-- IMPORTANT PERFORMANCE NOTE
-- --------------------------
-- These functions are the REFERENCE implementation: correct, and fine for the
-- cached/low-uncached-QPS reality (see docs/authz_caching.md -- most list
-- requests are served from the Valkey scope-signature page cache, so few reach
-- the DB). The per-device predicate function does NOT push down to indexes.
-- For any hot path that bypasses the cache, the portal should GENERATE a
-- flattened WHERE clause from the effective scopes so the planner uses the
-- device indexes. The logic below is the executable specification of that WHERE.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Match one scope constraint against one device
-- ---------------------------------------------------------------------------
-- Dimensions map to promoted columns; unknown dimensions fall back to attrs jsonb.
-- product_path and region_path are hierarchical (ltree) and handled specially.
CREATE OR REPLACE FUNCTION authz_match_constraint(
    d device, p_dim text, p_op text, p_vals text[]
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    col   text;
    lpath ltree;
BEGIN
    IF p_dim IN ('product_path','region_path') THEN
        lpath := CASE p_dim WHEN 'product_path' THEN d.product_path ELSE d.region_path END;
        IF p_op = 'subtree' THEN
            RETURN EXISTS (SELECT 1 FROM unnest(p_vals) v WHERE lpath <@ v::ltree);
        END IF;
        RETURN COALESCE(lpath::text = ANY(p_vals), false);
    END IF;

    col := CASE p_dim
        WHEN 'country_iso'      THEN d.country_iso
        WHEN 'modality'         THEN d.modality
        WHEN 'customer_id'      THEN d.customer_id::text
        WHEN 'site_id'          THEN d.site_id::text
        WHEN 'gateway_id'       THEN d.gateway_id::text
        WHEN 'hospital_name'    THEN d.hospital_name
        WHEN 'software_version' THEN d.software_version
        ELSE (d.attrs ->> p_dim)            -- extensible dimension from jsonb
    END;

    -- COALESCE guards NULL device attributes: a NULL value never satisfies a
    -- constraint (otherwise NULL propagates through NOT and wrongly matches).
    RETURN COALESCE(CASE p_op
        WHEN 'in'      THEN col = ANY(p_vals)
        WHEN 'eq'      THEN col =  p_vals[1]
        WHEN 'gt'      THEN col >  p_vals[1]     -- text compare; version strings compare lexically
        WHEN 'ge'      THEN col >= p_vals[1]
        WHEN 'lt'      THEN col <  p_vals[1]
        WHEN 'le'      THEN col <= p_vals[1]
        WHEN 'between' THEN col >= p_vals[1] AND col <= p_vals[2]
        ELSE false
    END, false);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Does a device belong to a scope's set? (with graded access_requirement)
-- ---------------------------------------------------------------------------
--   single_system : device id in the explicit list -> always reaches the device.
--   attribute     : ALL constraints hold (vacuously true if none), THEN the
--                   device's access_requirement gates it:
--                     open     -> allowed
--                     device   -> denied (needs a single_system grant)
--                     customer -> allowed only if the scope explicitly names a
--                                 customer_id constraint
--                     site     -> allowed only if the scope explicitly names a
--                                 site_id constraint
CREATE OR REPLACE FUNCTION authz_device_in_scope(
    d device, p_scope_id uuid, p_kind text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_kind = 'single_system' THEN
        RETURN EXISTS (
            SELECT 1 FROM authz_scope_device sd
            WHERE sd.scope_id = p_scope_id AND sd.device_id = d.id
        );
    END IF;

    -- attribute scope: every constraint must hold
    IF EXISTS (
        SELECT 1 FROM authz_scope_constraint c
        WHERE c.scope_id = p_scope_id
          AND NOT authz_match_constraint(d, c.dimension, c.op, c.values)
    ) THEN
        RETURN false;
    END IF;

    -- access requirement gating
    CASE d.access_requirement
        WHEN 'open'     THEN RETURN true;
        WHEN 'device'   THEN RETURN false;   -- only single_system reaches it
        WHEN 'customer' THEN RETURN EXISTS (
            SELECT 1 FROM authz_scope_constraint c
            WHERE c.scope_id = p_scope_id AND c.dimension = 'customer_id');
        WHEN 'site'     THEN RETURN EXISTS (
            SELECT 1 FROM authz_scope_constraint c
            WHERE c.scope_id = p_scope_id AND c.dimension = 'site_id');
        ELSE RETURN false;
    END CASE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Effective scopes for a set of groups (WITH inheritance down the tree)
-- ---------------------------------------------------------------------------
-- A grant on an ANCESTOR group applies to descendant groups. principal_group.path
-- carries the ltree; gg.path @> ug.path means "grant's group is an ancestor of
-- (or equal to) the user's group". Groups without a path fall back to identity.
CREATE OR REPLACE FUNCTION authz_effective_scopes(
    p_group_ids uuid[], p_resource_type text, p_verb text
) RETURNS TABLE(scope_id uuid, kind text)
LANGUAGE sql STABLE AS $$
    SELECT DISTINCT g.scope_id, s.kind
    FROM authz_grant g
    JOIN authz_scope s            ON s.id = g.scope_id AND s.resource_type = p_resource_type
    JOIN authz_role_privilege rp  ON rp.role_id = g.role_id
    JOIN authz_privilege p        ON p.id = rp.privilege_id
                                  AND p.resource_type = p_resource_type
                                  AND p.verb = p_verb
    JOIN principal_group ug       ON ug.group_id = ANY(p_group_ids)
    JOIN principal_group gg       ON gg.group_id = g.group_id
                                  AND (gg.path @> ug.path OR gg.group_id = ug.group_id);
$$;

-- ---------------------------------------------------------------------------
-- 4. check() -- can these groups perform verb on this device?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION authz_can(
    p_group_ids uuid[], p_verb text, p_device_id uuid
) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM authz_effective_scopes(p_group_ids, 'device', p_verb) es
        JOIN device d ON d.id = p_device_id
        WHERE authz_device_in_scope(d, es.scope_id, es.kind)
    );
$$;

-- ---------------------------------------------------------------------------
-- 5. list() -- devices these groups can perform verb on, KEYSET paginated
-- ---------------------------------------------------------------------------
-- Cursor = (p_after_updated, p_after_id) from the last row of the previous page;
-- pass NULLs for the first page. O(page size), stable under concurrent writes.
CREATE OR REPLACE FUNCTION authz_list_devices(
    p_group_ids     uuid[],
    p_verb          text,
    p_after_updated timestamptz DEFAULT NULL,
    p_after_id      uuid        DEFAULT NULL,
    p_limit         int         DEFAULT 50
) RETURNS SETOF device
LANGUAGE sql STABLE AS $$
    WITH es AS (
        SELECT scope_id, kind
        FROM authz_effective_scopes(p_group_ids, 'device', p_verb)
    )
    SELECT d.*
    FROM device d
    WHERE EXISTS (
            SELECT 1 FROM es
            WHERE authz_device_in_scope(d, es.scope_id, es.kind)
          )
      AND (
            p_after_updated IS NULL
            OR (d.updated_at, d.id) < (p_after_updated, p_after_id)
          )
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT p_limit;
$$;

COMMIT;
