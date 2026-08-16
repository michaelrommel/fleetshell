-- migrate_dtm.sql  (GLOBAL plane: fleetshell)
--
-- Data Transfer Matrix (DTM): per FROM-country x variant rules that say, for a
-- destination country and a data class, whether transfer is permitted or denied.
-- The matrix is anchored in the FROM (data-origin) country -- a Country Manager
-- maintains their own country's outbound rules (authz: region:edit on that
-- country node in the Region Tree). See docs/data_transfer_matrix.md.
--
-- Storage model (decided): DENIAL-LIST, default = PERMIT.
--   * We store ONLY denied (from, to, variant, class) tuples (sparse).
--   * Absence of a row  => permitted.
--   * No matrix at all for a FROM country => everything permitted.
--   This mirrors the deployed Valkey keys (hash-tagged so a whole origin country
--   co-locates in one MemoryDB cluster slot, enabling atomic per-country swaps +
--   multi-key ops):
--       SET dtm:{<FROM>}:<TO>:<VARIANT>  members = DENIED class codes
--   aerosuite reads it single-key: SISMEMBER dtm:{<from>}:<to>:<variant> <class>.
--
-- Variant selection at runtime (decided): a device's customer carries a
--   `dtm_variant` (customer.dtm_variant); the device+customer pick Strict when
--   set, else Standard. A device with no customer uses the country's Standard
--   matrix if defined, else defaults to permitted. Variants are extensible
--   (more than Standard/Strict may be added later) -- hence a table, not an enum.
--
-- NOTE on the `STD` collision: data_class code 'STD' = "Smart Technical Data"
--   (a class), while dtm_variant code 'STD' = "Standard" (a variant). They live
--   in SEPARATE namespaces (class vs variant) and never overlap positionally in
--   the Valkey key: `dtm:{DE}:CN:STD` -> STD is the variant segment; the VALUE is
--   the denied class set. Kept as-is because aerosuite already reads `:STD`.
--
-- Apply on the global cluster after migrate_data_classification.sql.

BEGIN;

-- 1. Extend the data-class catalog (shared with the classification feature).
--    kind lets each consumer filter: aeroftp uses 'file' classes; remote
--    services (RDS/reactive sessions) consult 'connection' classes; 'distribution'
--    covers software/virus/option pushes to the device.
ALTER TABLE data_class ADD COLUMN IF NOT EXISTS kind   text NOT NULL DEFAULT 'file'
    CHECK (kind IN ('file','connection','distribution'));
ALTER TABLE data_class ADD COLUMN IF NOT EXISTS mrs_id text;   -- legacy MRS_DC_* identifier (stable key)

-- Tag the 8 pre-existing classification codes with their MRS identifier + kind.
UPDATE data_class SET mrs_id = 'MRS_DC_IO_REC_ProtectedHealthInformation',      kind='file' WHERE code='PHI';
UPDATE data_class SET mrs_id = 'MRS_DC_IO_REC_UtilizationPerformanceData',      kind='file' WHERE code='UPD';
UPDATE data_class SET mrs_id = 'MRS_DC_IO_REC_ResultData',                      kind='file' WHERE code='RD';
UPDATE data_class SET mrs_id = 'MRS_DC_IO_REC_PersonalData',                    kind='file' WHERE code='PII';
UPDATE data_class SET mrs_id = 'MRS_DC_IO_REC_AssetAndConfigurationData',       kind='file' WHERE code='ACD';
UPDATE data_class SET mrs_id = 'MRS_DC_IO_REC_DeviceServiceHistory',            kind='file' WHERE code='DSH';
UPDATE data_class SET mrs_id = 'MRS_DC_IO_REC_TechnicalStatusData',             kind='file' WHERE code='TSD';
UPDATE data_class SET mrs_id = 'MRS_DC_IO_REC_SmartTechnicalData',              kind='file' WHERE code='STD';

-- The DTM-only classes (sort_order continues after the classification set).
-- (Retired columns RD3/UPD3/PSHI/GFT that lingered in some old sheets are NOT
--  catalogued -- the importer ignores those columns; see dtm_dedup.py.)
INSERT INTO data_class (code, label, sort_order, kind, mrs_id) VALUES
    ('RS',   'Reactive Sessions',              9, 'connection',  'MRS_DC_IO_REC_ReactiveSessions'),
    ('RDS',  'Remote Desktop Sharing',        10, 'connection',  'MRS_DC_IO_REC_RemoteDesktopSharing'),
    ('RSWD', 'RSWD Status Feedbacks',         11, 'file',        'MRS_DC_IO_REC_RSWDStatusFeedbacks'),
    ('SWD',  'Software Distribution',         12, 'distribution','MRS_DC_IO_SENT_SoftwareDistribution'),
    ('SWDO', 'Software Distribution Orders',  13, 'distribution','MRS_DC_IO_SENT_SoftwareDistributionOrders'),
    ('VPD',  'Virus Pattern Distribution',    14, 'distribution','MRS_DC_IO_SENT_VirusPatternDistribution'),
    ('ROD',  'Remote Option Distribution',    15, 'distribution','MRS_DC_IO_SENT_RemoteOptionDistribution'),
    ('SMD',  'Smart Data',                    16, 'distribution','MRS_DC_IO_SENT_SmartData')
ON CONFLICT (code) DO UPDATE
    SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
        kind = EXCLUDED.kind, mrs_id = EXCLUDED.mrs_id;

-- Remove retired classes if a prior apply catalogued them (idempotent). Their
-- denials go first (dtm_deny FK has no cascade); classification never used them.
DELETE FROM dtm_deny                  WHERE class_code IN ('RD3','UPD3','PSHI','GFT');
DELETE FROM classification_rule_class WHERE code       IN ('RD3','UPD3','PSHI','GFT');
DELETE FROM data_class                WHERE code       IN ('RD3','UPD3','PSHI','GFT');

-- 2. Variants (extensible; Standard is the runtime default).
CREATE TABLE IF NOT EXISTS dtm_variant (
    code       text PRIMARY KEY,           -- 'STD','STR',... (matches Valkey key segment)
    label      text NOT NULL,
    sort_order int  NOT NULL DEFAULT 0
);
INSERT INTO dtm_variant (code, label, sort_order) VALUES
    ('STD', 'Standard', 1),
    ('STR', 'Strict',   2)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

-- 3. Matrix header: one row per FROM-country x variant that has been DEFINED.
--    Presence here is how the runtime knows a country published a matrix (the
--    "country's Standard matrix if defined, else permit" fallback). default_decision
--    stays 'permit' (denial-list model) but is kept for future flexibility.
CREATE TABLE IF NOT EXISTS dtm_matrix (
    from_iso         text NOT NULL,        -- ISO-3166 alpha-2 of the origin country
    variant          text NOT NULL REFERENCES dtm_variant(code),
    default_decision text NOT NULL DEFAULT 'permit' CHECK (default_decision IN ('permit','deny')),
    updated_by       text,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (from_iso, variant)
);

-- 4. The sparse denial list: only (from, to, variant, class) tuples that are DENIED.
CREATE TABLE IF NOT EXISTS dtm_deny (
    from_iso   text NOT NULL,
    to_iso     text NOT NULL,
    variant    text NOT NULL REFERENCES dtm_variant(code),
    class_code text NOT NULL REFERENCES data_class(code),
    PRIMARY KEY (from_iso, to_iso, variant, class_code),
    FOREIGN KEY (from_iso, variant) REFERENCES dtm_matrix(from_iso, variant) ON DELETE CASCADE
);
-- Spool + editor read all denials for one FROM-country x variant at once.
CREATE INDEX IF NOT EXISTS ix_dtm_deny_from_variant ON dtm_deny(from_iso, variant);
CREATE INDEX IF NOT EXISTS ix_dtm_deny_pair         ON dtm_deny(from_iso, to_iso, variant);

-- 5. Customer-level variant selector (null => Standard). Extensible via dtm_variant.
ALTER TABLE customer ADD COLUMN IF NOT EXISTS dtm_variant text REFERENCES dtm_variant(code);

-- 6. authz vocabulary: DTM edits are gated by the region privilege on the FROM
--    country (a Country Manager concern). No new resource type needed.

COMMIT;
