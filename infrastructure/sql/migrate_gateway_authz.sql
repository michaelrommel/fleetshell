-- migrate_gateway_authz.sql  (GLOBAL plane: fleetshell)
--
-- Brings gateways under the SAME authorization model as devices: a gateway is
-- authorized by its REGION (the natural dimension for regional infrastructure).
-- Devices carry an id-based `region_path ltree`; gateways only carried a region
-- NAME (`region text`, from REGIONNAME). This migration:
--   1. adds gateway.region_path (ltree) + a GiST index,
--   2. backfills it from the region catalog by name (deterministic pick),
--   3. defines authz_visible_gateway_ids / authz_list_gateways / authz_can_gateway
--      mirroring the device fast path (region-subtree + full-wildcard; gateways
--      have no product/customer/site/single_system/access_requirement).
--
-- Idempotent. Apply AFTER the gateway + region tables are populated (the backfill
-- needs both), i.e. after load.py. reload.sh runs it after the import step.

BEGIN;

-- 1. Column + index --------------------------------------------------------
ALTER TABLE gateway ADD COLUMN IF NOT EXISTS region_path ltree;
CREATE INDEX IF NOT EXISTS ix_gateway_region_path ON gateway USING gist (region_path);

-- 2. Backfill region_path from the region catalog by NAME.
--    SAFETY NET ONLY as of Slice D: load.py now sets gateway.region_path
--    directly from RDRSROUTER.REGIONID (exact), so this UPDATE only fills the
--    few gateways whose REGIONID was 0/unmapped at import time. Kept because it
--    is idempotent and harmless (WHERE region_path IS NULL).
--    The gateway's `region` is a REGIONNAME string; region.name is the same
--    source column. Names should be unique at the coarse (VPC/region) level a
--    gateway lives in; DISTINCT ON collapses any accidental dup to a single
--    deterministic node (shallowest level, then lowest id). Unmatched gateways
--    keep region_path NULL -> they match NO region-scoped grant (the
--    NULL-attribute = no-match invariant), only a full-wildcard gateway grant.
UPDATE gateway g
   SET region_path = sub.path
  FROM (
        SELECT DISTINCT ON (name) name, path
          FROM region
         ORDER BY name, level, id
       ) sub
 WHERE g.region_path IS NULL
   AND g.region IS NOT NULL AND g.region <> ''
   AND sub.name = g.region;

-- 3a. Visible gateway-id set for a verb: region-subtree scopes (collapsed into
--     one array scan over the GiST index) UNION the full-wildcard attribute
--     scope. Reuses the generic authz_effective_scope_rows pivot with
--     resource_type='gateway'; only the region dimension is meaningful for
--     gateways, so product/customer/site must be NULL on the matching shapes.
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
    -- region subtree (collapsed)
    SELECT g.id FROM gateway g, ro
     WHERE ro.a IS NOT NULL AND g.region_path IS NOT NULL
       AND g.region_path <@ ANY(ro.a)
    UNION
    -- full-wildcard attribute scope (no constraints) -> every gateway
    SELECT g.id FROM gateway g
     WHERE EXISTS (SELECT 1 FROM es WHERE kind='attribute'
                   AND region_path IS NULL AND product_path IS NULL
                   AND customer_id IS NULL AND site_id IS NULL);
$$;

-- 3b. LIST: keyset-paginated visible gateways (by id, matching the page's order).
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

-- 3c. CHECK: point test for one gateway (fetch by PK, test the small scope set).
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
