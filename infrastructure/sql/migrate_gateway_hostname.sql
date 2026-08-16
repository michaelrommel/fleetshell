-- migrate_gateway_hostname.sql
-- Repurpose the synthetic gateway `dns_name` (gw-<id>.gateway.fleetshell.com,
-- a leftover identifier) into a real, nullable `hostname` for the dynamic-IP /
-- DynDNS case (a gateway reached by name instead of a fixed public IP). Drops
-- the UNIQUE NOT NULL, clears the fabricated values. Idempotent. Apply against
-- the GLOBAL cluster; run BEFORE load.py (the importer no longer writes it).

BEGIN;

-- dns_name -> hostname (nullable).
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'gateway' AND column_name = 'dns_name')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'gateway' AND column_name = 'hostname') THEN
        ALTER TABLE gateway RENAME COLUMN dns_name TO hostname;
    END IF;
END $$;

ALTER TABLE gateway DROP CONSTRAINT IF EXISTS gateway_dns_name_key;   -- the old UNIQUE
ALTER TABLE gateway ADD COLUMN IF NOT EXISTS hostname text;           -- if it was absent
ALTER TABLE gateway ALTER COLUMN hostname DROP NOT NULL;

-- Clear the fabricated gw-*.gateway.fleetshell.com placeholders (that domain is
-- reserved for the AWS NLB, not customer gateways).
UPDATE gateway SET hostname = NULL WHERE hostname LIKE 'gw-%.gateway.fleetshell.com';

COMMIT;
