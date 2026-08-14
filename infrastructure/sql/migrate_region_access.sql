-- migrate_region_access.sql  (GLOBAL plane: fleetshell)
--
-- Two model refinements driven by the real data:
--  1. Geography merged into ONE region hierarchy (World > Region > Country >
--     State) as an ltree; devices carry region_path; scopes match region SUBTREE
--     (a grant on a region node covers everything beneath). Replaces flat
--     country/state columns.
--  2. Graded access requirement propagated from customer/site:
--     device.access_requirement in ('open','device','customer','site').
--       open     -> reachable by any matching (attribute) grant
--       device   -> only a single_system grant listing the device
--       customer -> only a grant whose scope explicitly names the customer
--       site     -> only a grant whose scope explicitly names the site
--     Generalizes the old boolean explicit_grant_only.
--
-- Apply on the global cluster, then re-apply authz_resolve.sql and re-seed.

BEGIN;

-- 1. Region hierarchy (merges RDCOUNTRY + RDREGION). Path is ID-based
--    (e.g. '1.20.3150.315001') so labels are always valid ltree tokens.
CREATE TABLE IF NOT EXISTS region (
    id        bigint PRIMARY KEY,        -- source RDREGION.ID
    path      ltree  NOT NULL,           -- ID-based ancestor path
    name      text   NOT NULL,
    iso       text,                      -- ISO code for country-level nodes
    level     int    NOT NULL,           -- 1 World, 2 Region, 3 Country, 4 State
    parent_id bigint REFERENCES region(id)
);
CREATE INDEX IF NOT EXISTS ix_region_path ON region USING gist (path);

-- 2. device changes
ALTER TABLE device ADD COLUMN IF NOT EXISTS region_path ltree;
ALTER TABLE device ADD COLUMN IF NOT EXISTS country_iso text;   -- denormalized for display/filter
ALTER TABLE device ADD COLUMN IF NOT EXISTS access_requirement text NOT NULL DEFAULT 'open'
    CHECK (access_requirement IN ('open','device','customer','site'));

CREATE INDEX IF NOT EXISTS ix_device_region_path ON device USING gist (region_path);
CREATE INDEX IF NOT EXISTS ix_device_country_iso ON device(country_iso);

-- migrate the old boolean, then retire the flat geo columns
UPDATE device SET access_requirement = 'device' WHERE explicit_grant_only;
ALTER TABLE device DROP COLUMN IF EXISTS explicit_grant_only;
DROP INDEX IF EXISTS ix_device_country;
ALTER TABLE device DROP COLUMN IF EXISTS country;
ALTER TABLE device DROP COLUMN IF EXISTS state;

-- 3. customer / site: the "requires explicit grant" checkboxes
ALTER TABLE customer      ADD COLUMN IF NOT EXISTS requires_explicit_grant boolean NOT NULL DEFAULT false;
ALTER TABLE customer_site ADD COLUMN IF NOT EXISTS requires_explicit_grant boolean NOT NULL DEFAULT false;

-- 4. authz vocabulary for the region/country structure
INSERT INTO authz_resource_type (key, description) VALUES
    ('region','Region / country structure')
ON CONFLICT (key) DO NOTHING;

INSERT INTO authz_privilege (resource_type, verb) VALUES
    ('region','view'), ('region','create'), ('region','edit'), ('region','delete')
ON CONFLICT (resource_type, verb) DO NOTHING;

COMMIT;
