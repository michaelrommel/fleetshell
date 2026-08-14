-- migrate_device_identity.sql
-- Adds the searchable device-identity fields imported from RDSERVICEDSYSTEM
-- (serial, functional location, technical ident, host/hardware id, order number,
-- IP addresses, contact) + trigram indexes for the Google-style device search.
-- Apply against the GLOBAL cluster; idempotent; re-apply after a data reload
-- (load.py recreates `device`), and it must run BEFORE load.py so the columns
-- exist when the importer writes them. See docs/product_admin.md / devices work.

BEGIN;

ALTER TABLE device
    ADD COLUMN IF NOT EXISTS serial              text,   -- SERIAL
    ADD COLUMN IF NOT EXISTS functional_location text,   -- IDENTIFIER3 (NNN-NNNNNN)
    ADD COLUMN IF NOT EXISTS technical_ident     text,   -- SYSTEMID2 ("Technical Ident")
    ADD COLUMN IF NOT EXISTS host_hw_id          text,   -- HOSTID ("Host/Hardware ID")
    ADD COLUMN IF NOT EXISTS order_number        text,   -- ORDERNO
    ADD COLUMN IF NOT EXISTS ip_address          text,   -- IPADDRESS1 (primary)
    ADD COLUMN IF NOT EXISTS ip_real             text,   -- REALIPADDRESS (secondary)
    ADD COLUMN IF NOT EXISTS contact             text;   -- CONTACT (PII; anonymized)

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_device_serial_trgm ON device USING gin (serial gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_fl_trgm     ON device USING gin (functional_location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_ip_trgm     ON device USING gin (ip_address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_ipreal_trgm ON device USING gin (ip_real gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_tid_trgm    ON device USING gin (technical_ident gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_host_trgm   ON device USING gin (host_hw_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_device_ordno_trgm  ON device USING gin (order_number gin_trgm_ops);

COMMIT;
