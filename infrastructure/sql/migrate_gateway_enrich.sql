-- migrate_gateway_enrich.sql
-- Enriches the gateway (RS router = communication interface) rows with the
-- detail-view fields imported from RDRSROUTERDETAILVIEWV1: router name (raw),
-- city (anonymized), router/connection/operational type codes, admin IPs
-- (anonymized), country. Also renames label -> hospital. Apply against the
-- GLOBAL cluster; idempotent; must run BEFORE load.py so the columns exist when
-- the importer writes them. See docs/portal_ui.md (Gateways).

BEGIN;

-- label -> hospital (the anonymized customer/hospital name).
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'gateway' AND column_name = 'label')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'gateway' AND column_name = 'hospital') THEN
        ALTER TABLE gateway RENAME COLUMN label TO hospital;
    END IF;
END $$;
DROP INDEX IF EXISTS ix_gateway_label_trgm;

-- Drop the field we do not want.
ALTER TABLE gateway DROP COLUMN IF EXISTS end_of_service;

-- router_type was an earlier name for gateway_model (rename if it exists).
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'gateway' AND column_name = 'router_type')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'gateway' AND column_name = 'gateway_model') THEN
        ALTER TABLE gateway RENAME COLUMN router_type TO gateway_model;
    END IF;
END $$;

ALTER TABLE gateway
    ADD COLUMN IF NOT EXISTS hospital          text NOT NULL DEFAULT '',  -- if label was absent
    ADD COLUMN IF NOT EXISTS name              text,   -- NAME (router id / cisco serial) RAW
    ADD COLUMN IF NOT EXISTS city              text,   -- IDENTIFIER1 (anonymized; shared map)
    ADD COLUMN IF NOT EXISTS gateway_model     text,   -- DISPLAYROUTERTYPE ('undefined' -> NULL)
    ADD COLUMN IF NOT EXISTS connection_type   text,   -- CONNECTIONTYPE decoded
    ADD COLUMN IF NOT EXISTS operational_state text,   -- OPERATIONALSTATE decoded
    ADD COLUMN IF NOT EXISTS static_ip         text,   -- STATICIP
    ADD COLUMN IF NOT EXISTS nat_type          text,   -- NATTYPE
    ADD COLUMN IF NOT EXISTS admin_ip          text,   -- IPADDRESSADM1 (anonymized)
    ADD COLUMN IF NOT EXISTS admin_ip2         text,   -- IPADDRESSADM2 (anonymized)
    ADD COLUMN IF NOT EXISTS country           text;   -- COUNTRYNAME

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_gateway_name_trgm     ON gateway USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_gateway_hospital_trgm ON gateway USING gin (hospital gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_gateway_city_trgm     ON gateway USING gin (city gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_gateway_adminip_trgm  ON gateway USING gin (admin_ip gin_trgm_ops);

COMMIT;
