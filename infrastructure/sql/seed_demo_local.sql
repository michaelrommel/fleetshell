-- seed_demo_local.sql  (REGIONAL plane: fleetshell_local)
--
-- A couple of users mapped to groups from seed_demo.sql. In production the
-- portal resolves user -> groups HERE, then passes the group_ids to the global
-- authz functions. group_id is a cross-DB reference (no FK).
--   alice -> ccc_de_military   (inherits DE + CT + site + military-single)
--   bob   -> ccc_us            (inherits only CT, via the ccc-level grant)
--
-- Apply:  psql "host=$LW dbname=fleetshell_local user=fsadmin sslmode=require" -f seed_demo_local.sql

BEGIN;

INSERT INTO app_user (user_id, home_region, firstname, lastname, email, address_style) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','eu-west-2','Alice','Meyer','alice@example.com','Ms Meyer'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001','us-east-1','Bob','Nolan','bob@example.com','Bob')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO group_membership (group_id, user_id) VALUES
    ('11111111-1111-1111-1111-111111110004','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'),  -- alice -> ccc_de_military
    ('11111111-1111-1111-1111-111111110005','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001')   -- bob   -> ccc_us
ON CONFLICT (group_id, user_id) DO NOTHING;

COMMIT;
