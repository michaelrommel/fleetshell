-- migrate_gateway_nat_mode.sql  (GLOBAL plane: fleetshell)
--
-- Moves NAT ownership from a per-DEVICE flag to a per-SITE (gateway) flag, and
-- retires the meaningless legacy `nat_type` column.
--
-- Background: `nat_mode` decides how the fleetipsec:nat spool + the ipsecnode
-- data plane treat a site's device addresses:
--
--   'customer'  -- the customer's addresses are already unique in our view
--                  (their own public/reserved range, or they NAT before the
--                  tunnel). internal_ip = global_ip = device.ip_address. ipsecnode
--                  needs NO VPP NAT44 for this site -- decapsulated traffic is
--                  forwarded straight through (VPP bypass). This is the entire
--                  installed base today (0 devices were ever 'platform').
--   'backend'   -- WE translate (was device.nat_mode = 'platform'):
--                  internal_ip = device.ip_real, global_ip = device.ip_address.
--                  ipsecnode installs the per-site VPP VRF + NAT44 to disambiguate
--                  colliding RFC 1918 addresses across customers. Rare escape hatch.
--
-- Why per-site: the VPP-vs-bypass decision is uniform for a whole tunnel; a mixed
-- site is handled by policy (allocate distinct global_ips for the colliding
-- subset), not by per-address splitting. See fleetsuite AGENTS.md (Option 1).
--
-- `gateway.nat_type` (raw legacy NATTYPE) is dropped: it is the constant '1' on
-- every gateway (20121/20125), decoded by nothing and read by nothing, and its
-- name collides conceptually with the new operational `nat_mode`.
--
-- Idempotent; also folded into schema_global.sql. Apply against the GLOBAL cluster.

BEGIN;

-- 1. New per-site NAT ownership flag (default matches the entire installed base).
ALTER TABLE gateway
    ADD COLUMN IF NOT EXISTS nat_mode text NOT NULL DEFAULT 'customer'
                             CHECK (nat_mode IN ('customer','backend'));

-- 2. Backfill from the old per-device flag while it still exists: a gateway is
--    'backend' iff ANY attached device used the old 'platform' NAT. Guarded so a
--    re-run after the device column is dropped is a no-op.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'device' AND column_name = 'nat_mode') THEN
        UPDATE gateway g
           SET nat_mode = 'backend'
         WHERE EXISTS (SELECT 1 FROM device d
                        WHERE d.gateway_id = g.id AND d.nat_mode = 'platform');
    END IF;
END $$;

-- 3. Retire the constant, unused legacy NATTYPE column.
ALTER TABLE gateway DROP COLUMN IF EXISTS nat_type;

-- 4. Drop the per-device flag (superseded by the per-site gateway flag).
ALTER TABLE device DROP COLUMN IF EXISTS nat_mode;

COMMIT;
