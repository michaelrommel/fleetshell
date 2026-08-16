-- migrate_gateway_ipsec.sql
-- Adds the IPsec tunnel / crypto fields to the gateway (the operational
-- connection data authored in the UI and later spooled to Valkey fleetipsec:*,
-- keyed by public_ip). Mirrors fleetshell-portal src/lib/server/gateways.ts
-- (SiteRecord). Not populated from the legacy CSV import. Apply against the
-- GLOBAL cluster; idempotent.

BEGIN;

ALTER TABLE gateway
    ADD COLUMN IF NOT EXISTS public_ip text,   -- external tunnel endpoint IP (Valkey key)
    ADD COLUMN IF NOT EXISTS psk       text,   -- IPsec pre-shared key
    ADD COLUMN IF NOT EXISTS ipsec     jsonb;  -- SiteRecord crypto/tunnel params

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_gateway_publicip_trgm ON gateway USING gin (public_ip gin_trgm_ops);

COMMIT;
