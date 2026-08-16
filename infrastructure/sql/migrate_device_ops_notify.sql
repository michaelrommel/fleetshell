-- migrate_device_ops_notify.sql  (GLOBAL plane: fleetshell)
--
-- Takes over the remaining RDSERVICEDSYSTEM fields onto device:
--   * config_state / operational_state -- raw legacy enum codes (label map in UI)
--   * notify_* booleans                -- unpacked from the 4-char NOTIFYONACCESS
--                                         code (m/0 access, m/0 disconnect,
--                                         w/0 info-active, a/0 pseudonymized)
--   * notification_address             -- NOTIFICATIONADDRESS (PII email)
--   * display_before_connect           -- SHOWONCONNECT (operator free text)
--   * additional_info                  -- ANNOTATIONS (operator free text)
--
-- Idempotent. Runs BEFORE load.py on the global cluster.

ALTER TABLE device ADD COLUMN IF NOT EXISTS config_state             smallint;
ALTER TABLE device ADD COLUMN IF NOT EXISTS operational_state        smallint;
ALTER TABLE device ADD COLUMN IF NOT EXISTS notify_on_access         boolean;
ALTER TABLE device ADD COLUMN IF NOT EXISTS notify_on_disconnect     boolean;
ALTER TABLE device ADD COLUMN IF NOT EXISTS notification_info_active boolean;
ALTER TABLE device ADD COLUMN IF NOT EXISTS notify_pseudonymized     boolean;
ALTER TABLE device ADD COLUMN IF NOT EXISTS notification_address     text;
ALTER TABLE device ADD COLUMN IF NOT EXISTS display_before_connect   text;
ALTER TABLE device ADD COLUMN IF NOT EXISTS additional_info          text;
