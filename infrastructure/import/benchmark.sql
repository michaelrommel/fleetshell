-- benchmark.sql  (GLOBAL plane: fleetshell)  -- run after load.py --stage all
--
-- Validates the performance thesis at real volume: the authorized list query
-- must use indexes (region/product GiST, etc.), not a seq scan, and the first
-- keyset page must be fast even for a wide grant.
--
-- Adjust :grp to a broad group label if 'RSC' is not the widest in your data
-- (SELECT label, count(*) FROM authz_grant JOIN principal_group USING(...) ...).

\timing on

\echo '=== widest groups by grant count ==='
SELECT pg.label, count(*) AS grants
FROM authz_grant ag JOIN principal_group pg ON pg.group_id = ag.group_id
GROUP BY pg.label ORDER BY grants DESC LIMIT 10;

\echo '=== pick one broad group ==='
SELECT group_id AS grp FROM principal_group WHERE label = 'RSC' LIMIT 1 \gset

\echo '=== effective view scope count for that group ==='
SELECT count(*) FROM authz_effective_scopes(ARRAY[:'grp']::uuid[], 'device', 'view');

\echo '=== LIST first page (keyset) -- plan + timing ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM authz_list_devices(ARRAY[:'grp']::uuid[], 'view', NULL, NULL, 50);

\echo '=== LIST count of the full visible set (worst case) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM authz_list_devices(ARRAY[:'grp']::uuid[], 'view', NULL, NULL, 1000000);

\echo '=== CHECK a single device (point auth) ==='
SELECT d.id FROM device d LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS)
SELECT authz_can(ARRAY[:'grp']::uuid[], 'view', :'id');
