-- migrate_data_classification.sql
--
-- Data classification: assign fixed data classes to device files by a filename
-- regex, per (modality, product). Reusable modality-owned Rule Sets + a Mapping
-- (assignment) resolve into the Valkey hash data_classes:<MODALITY>:<PRODUCT>
-- that aeroftp consumes. See docs/data_classification.md.
--
-- Idempotent; also folded into schema_global.sql. Apply against GLOBAL:
--   psql "$GLOBAL_WRITER_URL" -f migrate_data_classification.sql

BEGIN;

-- The fixed catalog of data classes (seeded; the set does not change).
CREATE TABLE IF NOT EXISTS data_class (
    code       text PRIMARY KEY,          -- 'PHI','UPD','RD','PII','ACD','DSH','TSD','STD'
    label      text NOT NULL,
    sort_order int  NOT NULL DEFAULT 0
);

INSERT INTO data_class (code, label, sort_order) VALUES
    ('PHI', 'Protected Health Information',      1),
    ('UPD', 'Utilization & Performance Data',    2),
    ('RD',  'Result Data',                       3),
    ('PII', 'Personal Identifiable Information', 4),
    ('ACD', 'Asset & Configuration Data',        5),
    ('DSH', 'Device Service History',            6),
    ('TSD', 'Technical Status Data',             7),
    ('STD', 'Smart Technical Data',              8)
ON CONFLICT (code) DO UPDATE
    SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

-- A reusable, named bundle of rules, owned by ONE modality (a kind='modality'
-- product node). Never crosses modalities -- matches the BU-rep authz boundary.
CREATE TABLE IF NOT EXISTS classification_set (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    modality_id uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,  -- kind='modality'
    name        text NOT NULL,
    description text,
    UNIQUE (modality_id, name)
);
CREATE INDEX IF NOT EXISTS ix_classification_set_modality ON classification_set(modality_id);

-- One rule = a filename regex (stored WITHOUT the surrounding /.../).
CREATE TABLE IF NOT EXISTS classification_rule (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    set_id     uuid NOT NULL REFERENCES classification_set(id) ON DELETE CASCADE,
    regex      text NOT NULL,
    sort_order int  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_classification_rule_set ON classification_rule(set_id);

-- The 'yes' data classes carried by a rule.
CREATE TABLE IF NOT EXISTS classification_rule_class (
    rule_id uuid NOT NULL REFERENCES classification_rule(id) ON DELETE CASCADE,
    code    text NOT NULL REFERENCES data_class(code),
    PRIMARY KEY (rule_id, code)
);

-- Assignment: attach a set to a product OR a family, or leave both NULL for a
-- modality-wide assignment. The target must live in the set's modality (enforced
-- in the app layer, since kind/modality are not expressible in a column CHECK).
CREATE TABLE IF NOT EXISTS classification_assignment (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    set_id     uuid NOT NULL REFERENCES classification_set(id) ON DELETE CASCADE,
    product_id uuid REFERENCES product(id) ON DELETE CASCADE,   -- kind='product'; NULL = not product-targeted
    family     text,                                            -- product.family value; NULL = not family-targeted
    CHECK ( (product_id IS NOT NULL)::int + (family IS NOT NULL)::int <= 1 )
);
CREATE INDEX IF NOT EXISTS ix_classification_assignment_set     ON classification_assignment(set_id);
CREATE INDEX IF NOT EXISTS ix_classification_assignment_product ON classification_assignment(product_id);

-- Prevent duplicate assignments of the same set to the same target. Partial
-- unique indexes handle the three target shapes (product / family / modality).
CREATE UNIQUE INDEX IF NOT EXISTS ux_classification_assign_product
    ON classification_assignment(set_id, product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_classification_assign_family
    ON classification_assignment(set_id, family) WHERE family IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_classification_assign_modality
    ON classification_assignment(set_id) WHERE product_id IS NULL AND family IS NULL;

COMMIT;
