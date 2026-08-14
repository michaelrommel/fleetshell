-- diag_shapes.sql  -- diagnose which scope shapes dominate a group, and get the
-- REAL (inlined) plan of the visible-id union so we can see per-branch cost.
--
-- Usage:  psql "$GW" -v grp="BU_MR" -f diag_shapes.sql > diag_bu_mr.txt 2>&1
--         psql "$GW" -v grp="RSC"   -f diag_shapes.sql > diag_rsc.txt   2>&1

\set ON_ERROR_STOP on

\echo '=== effective scope SHAPE histogram for the group ==='
SELECT
    (region_path  IS NOT NULL) AS has_region,
    (product_path IS NOT NULL) AS has_product,
    (customer_id  IS NOT NULL) AS has_customer,
    (site_id      IS NOT NULL) AS has_site,
    kind,
    count(*)
FROM authz_effective_scope_rows(
    ARRAY[(SELECT group_id FROM principal_group WHERE label = :'grp' LIMIT 1)]::uuid[],
    'device', 'view')
GROUP BY 1,2,3,4,5
ORDER BY count DESC;

\echo '=== REAL plan of the visible-id union (inlined, count only) ==='
EXPLAIN (ANALYZE, BUFFERS)
WITH es AS MATERIALIZED (
    SELECT * FROM authz_effective_scope_rows(
        ARRAY[(SELECT group_id FROM principal_group WHERE label = :'grp' LIMIT 1)]::uuid[],
        'device', 'view')
),
ro AS (SELECT array_agg(region_path)  a FROM es WHERE kind='attribute' AND region_path IS NOT NULL AND product_path IS NULL AND customer_id IS NULL AND site_id IS NULL),
po AS (SELECT array_agg(product_path) a FROM es WHERE kind='attribute' AND product_path IS NOT NULL AND region_path IS NULL AND customer_id IS NULL AND site_id IS NULL),
co AS (SELECT array_agg(customer_id)  a FROM es WHERE kind='attribute' AND customer_id IS NOT NULL AND region_path IS NULL AND product_path IS NULL AND site_id IS NULL),
so AS (SELECT array_agg(site_id)      a FROM es WHERE kind='attribute' AND site_id IS NOT NULL AND region_path IS NULL AND product_path IS NULL AND customer_id IS NULL)
SELECT count(*) FROM (
    SELECT d.id FROM device d, ro WHERE ro.a IS NOT NULL AND d.access_requirement='open' AND d.region_path <@ ANY(ro.a)
    UNION
    SELECT d.id FROM device d, po WHERE po.a IS NOT NULL AND d.access_requirement='open' AND d.product_path <@ ANY(po.a)
    UNION
    SELECT d.id FROM device d, co WHERE co.a IS NOT NULL AND d.access_requirement IN ('open','customer') AND d.customer_id = ANY(co.a)
    UNION
    SELECT d.id FROM device d, so WHERE so.a IS NOT NULL AND d.access_requirement IN ('open','site') AND d.site_id = ANY(so.a)
    UNION
    SELECT d.id FROM es JOIN device d ON d.region_path <@ es.region_path
      WHERE es.kind='attribute' AND es.region_path IS NOT NULL
        AND (es.product_path IS NOT NULL OR es.customer_id IS NOT NULL OR es.site_id IS NOT NULL)
        AND (es.product_path IS NULL OR d.product_path <@ es.product_path)
        AND (es.customer_id  IS NULL OR d.customer_id = es.customer_id)
        AND (es.site_id      IS NULL OR d.site_id = es.site_id)
        AND (d.access_requirement='open' OR (d.access_requirement='customer' AND es.customer_id IS NOT NULL) OR (d.access_requirement='site' AND es.site_id IS NOT NULL))
    UNION
    SELECT d.id FROM es JOIN device d ON d.product_path <@ es.product_path
      WHERE es.kind='attribute' AND es.region_path IS NULL AND es.product_path IS NOT NULL
        AND (es.customer_id IS NOT NULL OR es.site_id IS NOT NULL)
        AND (es.customer_id IS NULL OR d.customer_id = es.customer_id)
        AND (es.site_id     IS NULL OR d.site_id = es.site_id)
        AND (d.access_requirement='open' OR (d.access_requirement='customer' AND es.customer_id IS NOT NULL) OR (d.access_requirement='site' AND es.site_id IS NOT NULL))
    UNION
    SELECT sd.device_id FROM es JOIN authz_scope_device sd ON sd.scope_id = es.scope_id WHERE es.kind='single_system'
) v;
