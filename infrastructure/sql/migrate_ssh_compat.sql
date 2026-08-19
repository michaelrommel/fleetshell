-- migrate_ssh_compat.sql  (GLOBAL plane: fleetshell)
--
-- Adds the per-application `ssh_compat` flag to the application template
-- (product_model_app) and its per-device override (device_app), and threads it
-- through resolve_apps().
--
-- `ssh_compat` is only meaningful for application='ssh' in direct (russh) mode
-- (guac=false, e2ecrypt=false). When true, the portal embeds an `ssh_compat`
-- JWT claim so the gateway's direct-SSH handler additionally offers legacy
-- key-exchange / cipher / MAC algorithms for ancient field devices. It has no
-- effect on guacd or e2e paths. Idempotent; folded into schema_global.sql; runs
-- AFTER migrate_device_app.sql (which defines both tables + resolve_apps).

BEGIN;

ALTER TABLE product_model_app ADD COLUMN IF NOT EXISTS ssh_compat boolean NOT NULL DEFAULT false;
ALTER TABLE device_app        ADD COLUMN IF NOT EXISTS ssh_compat boolean NOT NULL DEFAULT false;

-- Recreate resolve_apps() with the extra column. Device rows (full override)
-- win over model defaults, exactly as before. DROP first: Postgres cannot change
-- a function's OUT-parameter (return row) shape via CREATE OR REPLACE.
DROP FUNCTION IF EXISTS resolve_apps(uuid);
CREATE OR REPLACE FUNCTION resolve_apps(p_device_id uuid)
RETURNS TABLE(name text, application text, ports text, guac boolean, e2ecrypt boolean,
              sni text, path text, width int, height int, dpi int, drive boolean,
              record boolean, ssh_compat boolean, params jsonb, source text)
LANGUAGE sql STABLE AS $$
    SELECT da.name, da.application, da.ports, da.guac, da.e2ecrypt, da.sni, da.path,
           da.width, da.height, da.dpi, da.drive, da.record, da.ssh_compat, da.params, 'device'::text
    FROM device_app da WHERE da.device_id = p_device_id
    UNION ALL
    SELECT pma.name, pma.application, pma.ports, pma.guac, pma.e2ecrypt, pma.sni, pma.path,
           pma.width, pma.height, pma.dpi, pma.drive, pma.record, pma.ssh_compat, pma.params, 'model'::text
    FROM device d
    JOIN product m             ON m.path = d.product_path
    JOIN product_model_app pma ON pma.product_id = m.id
    WHERE d.id = p_device_id
      AND NOT EXISTS (SELECT 1 FROM device_app da2 WHERE da2.device_id = p_device_id)
    ORDER BY 2, 1;
$$;

COMMIT;
