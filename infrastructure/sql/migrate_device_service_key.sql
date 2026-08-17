-- migrate_device_service_key.sql  (GLOBAL plane: fleetshell)
--
-- Slice F: per-device service key (RDSERVICEKEY) transmitted in the tunnel
-- request by the portal Connect workflow. `service_key` is a CREDENTIAL (faked
-- under ANONYMIZE); level + expiry are non-secret metadata. Idempotent. Folded
-- into schema_global.sql; MUST run BEFORE load.py (which writes these columns).

ALTER TABLE device ADD COLUMN IF NOT EXISTS service_key         text;
ALTER TABLE device ADD COLUMN IF NOT EXISTS service_key_level   text;
ALTER TABLE device ADD COLUMN IF NOT EXISTS service_key_expires text;

-- All of a device's service keys (a device usually has several). device.*
-- above stays the RESOLVED DEFAULT (used by the tunnel); this satellite backs
-- the multi-key UI (list all, show expiry, flag default). is_default marks the
-- one mirrored onto device.service_key.
CREATE TABLE IF NOT EXISTS device_service_key (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    service_key text NOT NULL,
    level       text,
    expires     text,
    is_default  boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ix_device_service_key_device ON device_service_key(device_id);
