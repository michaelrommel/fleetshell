-- migrate_theme_global.sql  (GLOBAL plane: fleetshell)
-- Org-wide default theme (admin-controlled). Apply on the global cluster.

CREATE TABLE IF NOT EXISTS app_setting (
    key   text PRIMARY KEY,
    value text NOT NULL
);

INSERT INTO app_setting (key, value) VALUES ('default_theme', 'nucleus')
ON CONFLICT (key) DO NOTHING;
