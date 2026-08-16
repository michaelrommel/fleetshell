-- migrate_device_gateway_spool.sql
--
-- Fields required by the device/gateway Valkey spoolers (systems:by-ip + the
-- fleetipsec:* keys). See docs/valkey_spool.md.
--
--   device.nat_mode      -- per-device NAT ownership: 'customer' (customer already
--                           NATs; internal_ip = global_ip = ip_address) vs
--                           'platform' (we NAT; internal_ip = ip_real). Drives the
--                           fleetipsec:nat:<public_ip> device_nat[] internal_ip.
--   device.internal_use  -- contract flag: 'STD' (Standard) | 'NIU' (No internal
--                           use) | NULL (neither). Spooled into systems:by-ip
--                           `contracts` (comma-joined with dpa/dmy).
--   device.dpa           -- Data Processing Agreement (independent toggle).
--   device.dmy           -- Dummy (independent toggle).
--
--   gateway.tunnel_gateway -- the regional fleetshell-gateway LB address used as
--                             the Connect JWT `gateway` claim (one per AWS region;
--                             MOVED here off the device -- a device resolves it via
--                             its IPsec gateway).
--   gateway.backend_access_ip / backend_sd_ip / backend_em_ip -- customer-view IPs
--                             for the three backend roles -> fleetipsec:nat
--                             backend_nat {access_server,sd_server,em_server}. The
--                             real IPs live in ipsecnode.toml, not Valkey.
--
-- Idempotent; also folded into schema_global.sql. Apply against GLOBAL.

BEGIN;

-- Device: NAT mode + contract flags.
ALTER TABLE device
    ADD COLUMN IF NOT EXISTS nat_mode     text NOT NULL DEFAULT 'customer'
                             CHECK (nat_mode IN ('customer','platform')),
    ADD COLUMN IF NOT EXISTS internal_use text
                             CHECK (internal_use IN ('STD','NIU')),   -- NULL = neither
    ADD COLUMN IF NOT EXISTS dpa          boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS dmy          boolean NOT NULL DEFAULT false;

-- Gateway: Connect tunnel-gateway address (moved off device) + backend NAT IPs.
ALTER TABLE gateway
    ADD COLUMN IF NOT EXISTS tunnel_gateway    text,
    ADD COLUMN IF NOT EXISTS backend_access_ip text,
    ADD COLUMN IF NOT EXISTS backend_sd_ip     text,
    ADD COLUMN IF NOT EXISTS backend_em_ip     text;

-- Tunnel Gateway moved device -> gateway: drop the (wrong) per-device column.
ALTER TABLE device DROP COLUMN IF EXISTS tunnel_gateway;

COMMIT;
