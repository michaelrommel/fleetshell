-- migrate_region_tree.sql  (GLOBAL plane: fleetshell)
--
-- Support the /countries Region Tree editor: Country Manager roles add
-- sub-regions under their country (e.g. US states, Canada's Atlantic/Central/
-- East/West/Pacific). Imported region ids come straight from RDREGION.ID and
-- run up to ~7.1e8, so user-created nodes draw from a dedicated sequence that
-- starts well above any source id to avoid collisions with a later reload
-- (load.py COPYs with ON CONFLICT (id), so this sequence survives a reload).
--
-- Apply on the global cluster after migrate_region_access.sql.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS region_id_seq
    START WITH 1000000000
    MINVALUE 1000000000
    INCREMENT BY 1;

COMMIT;
