-- verify_demo.sql  (GLOBAL plane: fleetshell)  -- run after seed_demo.sql
--   alice group = ccc_de_military = 11111111-...110004
--   bob   group = ccc_us          = 11111111-...110005

\echo '=== 1. alice effective VIEW scopes -- expect 5: DE, CT, single, site, customer ==='
SELECT s.label, es.kind
FROM authz_effective_scopes(ARRAY['11111111-1111-1111-1111-111111110004']::uuid[], 'device','view') es
JOIN authz_scope s ON s.id = es.scope_id
ORDER BY s.label;

\echo '=== 2. alice VIEW list -- expect 7: DE/CT, DE/MR, device-explicit, US/CT, FR/CT, customer-explicit, site-explicit; NOT FR/MR ==='
SELECT country_iso, modality, hospital_name, access_requirement
FROM authz_list_devices(ARRAY['11111111-1111-1111-1111-111111110004']::uuid[], 'view', NULL, NULL, 50)
ORDER BY country_iso, modality, hospital_name;

\echo '=== 3. bob (ccc_us) VIEW list -- expect 3 open CT only (DE/US/FR); NO explicit/customer/site ==='
SELECT country_iso, modality, hospital_name, access_requirement
FROM authz_list_devices(ARRAY['11111111-1111-1111-1111-111111110005']::uuid[], 'view', NULL, NULL, 50)
ORDER BY country_iso, modality, hospital_name;

\echo '=== 4. point checks -- expect t, f, t, t, f, t, t ==='
SELECT
  authz_can(ARRAY['11111111-1111-1111-1111-111111110004']::uuid[],'connect','77777777-7777-7777-7777-777777770003') AS mil_connect_deviceexplicit_t,
  authz_can(ARRAY['11111111-1111-1111-1111-111111110005']::uuid[],'view',   '77777777-7777-7777-7777-777777770003') AS us_view_deviceexplicit_f,
  authz_can(ARRAY['11111111-1111-1111-1111-111111110005']::uuid[],'view',   '77777777-7777-7777-7777-777777770004') AS us_view_usct_t,
  authz_can(ARRAY['11111111-1111-1111-1111-111111110004']::uuid[],'edit',   '77777777-7777-7777-7777-777777770002') AS mil_edit_demr_t,
  authz_can(ARRAY['11111111-1111-1111-1111-111111110005']::uuid[],'edit',   '77777777-7777-7777-7777-777777770004') AS us_edit_usct_f,
  authz_can(ARRAY['11111111-1111-1111-1111-111111110004']::uuid[],'view',   '77777777-7777-7777-7777-777777770007') AS mil_view_customerexplicit_t,
  authz_can(ARRAY['11111111-1111-1111-1111-111111110004']::uuid[],'view',   '77777777-7777-7777-7777-777777770008') AS mil_view_siteexplicit_t;
