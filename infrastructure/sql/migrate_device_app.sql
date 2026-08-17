-- migrate_device_app.sql  (GLOBAL plane: fleetshell)
--
-- Slice G: per-device application overrides (device_app) + resolve_apps().
--   * product_model_app  = the MODEL's default apps (inherited by its devices).
--   * device_app         = a device's OWN apps; when present they REPLACE the
--                          model defaults for that device (full override, which
--                          is how the legacy per-system app configs behave).
-- Also extends the `application` enum to the kept legacy types (Teamviewer,
-- Transparent passthrough, and file transfer SCP/SFTP/FTP). Dropped legacy types
-- (ping / NetOp / Novius / X11 / pcanywhere / netmeeting / timbuktu / telnet ...)
-- are simply never imported. Idempotent; folded into schema_global.sql; runs
-- BEFORE load.py.

BEGIN;

-- The kept application set (see docs/second_load_analysis.md Slice G survey).
ALTER TABLE product_model_app DROP CONSTRAINT IF EXISTS product_model_app_application_check;
ALTER TABLE product_model_app ADD  CONSTRAINT product_model_app_application_check
    CHECK (application IN ('http','https','expert-i','rdp','vnc','ssh',
                           'teamviewer','transparent','scp','sftp','ftp'));
-- G-full: params jsonb -- faithfully-captured legacy params not yet a column
-- (https/transparent extra tcp/udp ports; teamviewer options). NULL = none.
ALTER TABLE product_model_app ADD COLUMN IF NOT EXISTS params jsonb;

CREATE TABLE IF NOT EXISTS device_app (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    name        text NOT NULL,
    application text NOT NULL
                CHECK (application IN ('http','https','expert-i','rdp','vnc','ssh',
                                       'teamviewer','transparent','scp','sftp','ftp')),
    ports       text NOT NULL DEFAULT '',
    guac        boolean NOT NULL DEFAULT false,
    e2ecrypt    boolean NOT NULL DEFAULT false,
    sni         text NOT NULL DEFAULT '',
    path        text NOT NULL DEFAULT '/',
    width       int  NOT NULL DEFAULT 1920,
    height      int  NOT NULL DEFAULT 1080,
    dpi         int  NOT NULL DEFAULT 96,
    drive       boolean NOT NULL DEFAULT false,
    record      boolean NOT NULL DEFAULT false,
    sort_order  int  NOT NULL DEFAULT 0,
    params      jsonb                       -- G-full: extra tcp/udp ports, teamviewer options
);
CREATE INDEX IF NOT EXISTS ix_device_app_device ON device_app(device_id);

-- Effective apps for a device: its own device_app rows if any (full override),
-- else the model's product_model_app defaults.
CREATE OR REPLACE FUNCTION resolve_apps(p_device_id uuid)
RETURNS TABLE(name text, application text, ports text, guac boolean, e2ecrypt boolean,
              sni text, path text, width int, height int, dpi int, drive boolean,
              record boolean, params jsonb, source text)
LANGUAGE sql STABLE AS $$
    SELECT da.name, da.application, da.ports, da.guac, da.e2ecrypt, da.sni, da.path,
           da.width, da.height, da.dpi, da.drive, da.record, da.params, 'device'::text
    FROM device_app da WHERE da.device_id = p_device_id
    UNION ALL
    SELECT pma.name, pma.application, pma.ports, pma.guac, pma.e2ecrypt, pma.sni, pma.path,
           pma.width, pma.height, pma.dpi, pma.drive, pma.record, pma.params, 'model'::text
    FROM device d
    JOIN product m             ON m.path = d.product_path
    JOIN product_model_app pma ON pma.product_id = m.id
    WHERE d.id = p_device_id
      AND NOT EXISTS (SELECT 1 FROM device_app da2 WHERE da2.device_id = p_device_id)
    ORDER BY 2, 1;
$$;

COMMIT;
