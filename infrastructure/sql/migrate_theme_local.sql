-- migrate_theme_local.sql  (REGIONAL plane: fleetshell_local)
-- Per-user theme preference. Apply on the local cluster.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS theme text;
