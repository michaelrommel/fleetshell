-- migrate_product_model.sql
-- Introduces the Product Model level and cleans up the product/model naming.
-- Apply against the GLOBAL cluster. Idempotent; also re-apply after a data
-- reload (load.py recreates `product`), alongside migrate_authz_catalog.sql.
-- See docs/product_admin.md.

BEGIN;

-- 1. Cleanup: partno / serial range were model attributes stored on `product`.
--    Drop them here; they are re-homed as bigint on product_model (step 3).
ALTER TABLE product DROP COLUMN IF EXISTS partno;
ALTER TABLE product DROP COLUMN IF EXISTS serial_from;
ALTER TABLE product DROP COLUMN IF EXISTS serial_to;

-- 2. Level discriminator + product-only family attribute.
ALTER TABLE product
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'product'
        CHECK (kind IN ('modality','product','model')),
    ADD COLUMN IF NOT EXISTS family text;
CREATE INDEX IF NOT EXISTS ix_product_kind ON product(kind);

-- Classify existing rows by tree depth (importer: modality = level-2 label).
--   nlevel 2 -> modality, nlevel 3 -> product, nlevel >= 4 -> model.
--   nlevel 1 (synthetic root, if any) -> left as modality (harmless sentinel).
-- No model nodes exist yet; they are authored in the UI and device.product_path
-- is re-pointed by a separate follow-up migration.
UPDATE product SET kind = CASE
    WHEN nlevel(path) <= 2 THEN 'modality'
    WHEN nlevel(path)  = 3 THEN 'product'
    ELSE 'model'
END;

-- 3. Model-level typed attributes (1:1 with a kind='model' node).
CREATE TABLE IF NOT EXISTS product_model (
    product_id       uuid PRIMARY KEY REFERENCES product(id) ON DELETE CASCADE,
    partno           bigint,
    serial_from      bigint,          -- inclusive lower bound (integer serials)
    serial_to        bigint,          -- inclusive upper bound
    is_host_computer boolean NOT NULL DEFAULT false
);

-- 4. Connect-application defaults for a model (mirrors the client AppProfile).
CREATE TABLE IF NOT EXISTS product_model_app (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,  -- the model node
    name        text NOT NULL,
    application text NOT NULL
                CHECK (application IN ('http','https','expert-i','rdp','vnc','ssh')),
    ports       text NOT NULL DEFAULT '',   -- '3389' or a range like '3000-3020'
    guac        boolean NOT NULL DEFAULT false,
    e2ecrypt    boolean NOT NULL DEFAULT false,
    sni         text NOT NULL DEFAULT '',
    path        text NOT NULL DEFAULT '/',
    width       int  NOT NULL DEFAULT 1920,
    height      int  NOT NULL DEFAULT 1080,
    dpi         int  NOT NULL DEFAULT 96,
    drive       boolean NOT NULL DEFAULT false,
    record      boolean NOT NULL DEFAULT false,
    sort_order  int  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_product_model_app_product ON product_model_app(product_id);

COMMIT;
