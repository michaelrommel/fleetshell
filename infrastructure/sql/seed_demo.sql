-- seed_demo.sql  (GLOBAL plane: fleetshell)
--
-- Exercises the refined model:
--   * region hierarchy (World > Region > Country > State) with SUBTREE scoping
--   * graded access_requirement (open|device|customer|site)
--   * grant inheritance down the group tree
-- Fixed UUIDs so verify_demo.sql can assert exact rows. Idempotent.
--
-- Region tree (id-based ltree path):
--   1 World
--   ├─ 20 EMEA
--   │  ├─ 3150 Germany (DE)  ── 315001 Bavaria
--   │  └─ 3140 France  (FR)
--   └─ 10 Americas ── 1320 USA (US)
--
-- Grants:
--   G1 ccc_de            / engineer / scope_de        (region subtree Germany)
--   G2 ccc               / viewer   / scope_ct        (product subtree ct)
--   G3 ccc_de_military   / engineer / scope_mil       (single_system)
--   G4 ccc_de            / viewer   / scope_site       (names site)
--   G5 ccc_de            / viewer   / scope_customer   (names customer)

BEGIN;

INSERT INTO region (id, path, name, iso, level, parent_id) VALUES
    (1,     '1',            'World',     NULL, 1, NULL),
    (20,    '1.20',         'EMEA',      NULL, 2, 1),
    (10,    '1.10',         'Americas',  NULL, 2, 1),
    (3150,  '1.20.3150',    'Germany',   'DE', 3, 20),
    (3140,  '1.20.3140',    'France',    'FR', 3, 20),
    (1320,  '1.10.1320',    'USA',       'US', 3, 10),
    (315001,'1.20.3150.315001','Bavaria',NULL, 4, 3150)
ON CONFLICT (id) DO NOTHING;

INSERT INTO gateway (id, dns_name, region, label) VALUES
    ('44444444-4444-4444-4444-444444440001','eu.gateway.fleetshell.com','eu-west-2','EU gateway'),
    ('44444444-4444-4444-4444-444444440002','us.gateway.fleetshell.com','us-east-1','US gateway')
ON CONFLICT (id) DO NOTHING;

INSERT INTO customer (id, country, name, requires_explicit_grant) VALUES
    ('55555555-5555-5555-5555-555555550001','DE','ACME Klinikgruppe', true)   -- customer-explicit
ON CONFLICT (id) DO NOTHING;

INSERT INTO customer_site (id, customer_id, country, name, requires_explicit_grant, membership_kind) VALUES
    ('66666666-6666-6666-6666-666666660001','55555555-5555-5555-5555-555555550001','DE',
     'Sunset Boulevard Hospital', true, 'dynamic')                            -- site-explicit
ON CONFLICT (id) DO NOTHING;

INSERT INTO customer_site_rule (site_id, dimension, values) VALUES
    ('66666666-6666-6666-6666-666666660001','hospital_name','{Sunset Boulevard Hospital}')
ON CONFLICT (site_id, dimension) DO NOTHING;

INSERT INTO product (id, path, name) VALUES
    ('88888888-8888-8888-8888-888888880001','ct','Computed Tomography'),
    ('88888888-8888-8888-8888-888888880003','ct.somatom.force','SOMATOM Force'),
    ('88888888-8888-8888-8888-888888880004','ct.somatom.drive','SOMATOM Drive'),
    ('88888888-8888-8888-8888-888888880006','mr.magnetom','MAGNETOM')
ON CONFLICT (id) DO NOTHING;

-- Devices (access_requirement in comments):
INSERT INTO device (id, region_path, country_iso, modality, product_path, customer_id, site_id,
                    gateway_id, hospital_name, software_version, access_requirement) VALUES
    -- open, DE/CT
    ('77777777-7777-7777-7777-777777770001','1.20.3150','DE','CT','ct.somatom.force',
        NULL, NULL, '44444444-4444-4444-4444-444444440001','Charite','VB20A','open'),
    -- open, DE(Bavaria)/MR, in Sunset site
    ('77777777-7777-7777-7777-777777770002','1.20.3150.315001','DE','MR','mr.magnetom',
        '55555555-5555-5555-5555-555555550001','66666666-6666-6666-6666-666666660001',
        '44444444-4444-4444-4444-444444440001','Sunset Boulevard Hospital','VB10A','open'),
    -- device-explicit, DE/CT (military)
    ('77777777-7777-7777-7777-777777770003','1.20.3150','DE','CT','ct.somatom.force',
        NULL, NULL, '44444444-4444-4444-4444-444444440001','Bundeswehr Hospital','VB20A','device'),
    -- open, US/CT
    ('77777777-7777-7777-7777-777777770004','1.10.1320','US','CT','ct.somatom.drive',
        NULL, NULL, '44444444-4444-4444-4444-444444440002','Mercy General','VB20A','open'),
    -- open, FR/CT
    ('77777777-7777-7777-7777-777777770005','1.20.3140','FR','CT','ct.somatom.force',
        NULL, NULL, '44444444-4444-4444-4444-444444440001','CHU Lyon','VB20A','open'),
    -- open, FR/MR  (negative: nobody sees it)
    ('77777777-7777-7777-7777-777777770006','1.20.3140','FR','MR','mr.magnetom',
        NULL, NULL, '44444444-4444-4444-4444-444444440001','CHU Lyon','VB20A','open'),
    -- customer-explicit, DE/CT (ACME)
    ('77777777-7777-7777-7777-777777770007','1.20.3150','DE','CT','ct.somatom.force',
        '55555555-5555-5555-5555-555555550001', NULL,
        '44444444-4444-4444-4444-444444440001','ACME Hospital','VB20A','customer'),
    -- site-explicit, DE/MR (Sunset)
    ('77777777-7777-7777-7777-777777770008','1.20.3150','DE','MR','mr.magnetom',
        '55555555-5555-5555-5555-555555550001','66666666-6666-6666-6666-666666660001',
        '44444444-4444-4444-4444-444444440001','Sunset Boulevard Hospital','VB10A','site')
ON CONFLICT (id) DO NOTHING;

INSERT INTO principal_group (group_id, home_region, label, path, parent_id) VALUES
    ('11111111-1111-1111-1111-111111110001','eu-west-2','Root','root', NULL),
    ('11111111-1111-1111-1111-111111110002','eu-west-2','CCC','root.ccc',
        '11111111-1111-1111-1111-111111110001'),
    ('11111111-1111-1111-1111-111111110003','eu-west-2','CCC Germany','root.ccc.ccc_de',
        '11111111-1111-1111-1111-111111110002'),
    ('11111111-1111-1111-1111-111111110004','eu-west-2','CCC Germany Military','root.ccc.ccc_de.ccc_de_military',
        '11111111-1111-1111-1111-111111110003'),
    ('11111111-1111-1111-1111-111111110005','us-east-1','CCC US','root.ccc.ccc_us',
        '11111111-1111-1111-1111-111111110002')
ON CONFLICT (group_id) DO NOTHING;

INSERT INTO authz_role (id, key, name) VALUES
    ('22222222-2222-2222-2222-222222220001','viewer','Device Viewer'),
    ('22222222-2222-2222-2222-222222220002','engineer','Service Engineer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO authz_role_privilege (role_id, privilege_id)
    SELECT '22222222-2222-2222-2222-222222220001', id
    FROM authz_privilege WHERE resource_type='device' AND verb='view'
ON CONFLICT DO NOTHING;

INSERT INTO authz_role_privilege (role_id, privilege_id)
    SELECT '22222222-2222-2222-2222-222222220002', id
    FROM authz_privilege WHERE resource_type='device' AND verb IN ('view','connect','edit')
ON CONFLICT DO NOTHING;

INSERT INTO authz_scope (id, resource_type, kind, label) VALUES
    ('33333333-3333-3333-3333-333333330001','device','attribute','Germany subtree'),
    ('33333333-3333-3333-3333-333333330002','device','attribute','All CT (any region)'),
    ('33333333-3333-3333-3333-333333330003','device','single_system','Military explicit'),
    ('33333333-3333-3333-3333-333333330004','device','attribute','Sunset site (names site)'),
    ('33333333-3333-3333-3333-333333330005','device','attribute','ACME customer (names customer)')
ON CONFLICT (id) DO NOTHING;

INSERT INTO authz_scope_constraint (scope_id, dimension, op, values) VALUES
    ('33333333-3333-3333-3333-333333330001','region_path','subtree','{1.20.3150}'),
    ('33333333-3333-3333-3333-333333330002','product_path','subtree','{ct}'),
    ('33333333-3333-3333-3333-333333330004','site_id','in','{66666666-6666-6666-6666-666666660001}'),
    ('33333333-3333-3333-3333-333333330005','customer_id','in','{55555555-5555-5555-5555-555555550001}')
ON CONFLICT DO NOTHING;

INSERT INTO authz_scope_device (scope_id, device_id) VALUES
    ('33333333-3333-3333-3333-333333330003','77777777-7777-7777-7777-777777770003')
ON CONFLICT DO NOTHING;

INSERT INTO authz_grant (id, group_id, role_id, scope_id) VALUES
    ('99999999-9999-9999-9999-999999990001','11111111-1111-1111-1111-111111110003',
        '22222222-2222-2222-2222-222222220002','33333333-3333-3333-3333-333333330001'),  -- G1 ccc_de/eng/DE
    ('99999999-9999-9999-9999-999999990002','11111111-1111-1111-1111-111111110002',
        '22222222-2222-2222-2222-222222220001','33333333-3333-3333-3333-333333330002'),  -- G2 ccc/view/CT
    ('99999999-9999-9999-9999-999999990003','11111111-1111-1111-1111-111111110004',
        '22222222-2222-2222-2222-222222220002','33333333-3333-3333-3333-333333330003'),  -- G3 military/eng/single
    ('99999999-9999-9999-9999-999999990004','11111111-1111-1111-1111-111111110003',
        '22222222-2222-2222-2222-222222220001','33333333-3333-3333-3333-333333330004'),  -- G4 ccc_de/view/site
    ('99999999-9999-9999-9999-999999990005','11111111-1111-1111-1111-111111110003',
        '22222222-2222-2222-2222-222222220001','33333333-3333-3333-3333-333333330005')   -- G5 ccc_de/view/customer
ON CONFLICT (id) DO NOTHING;

COMMIT;
