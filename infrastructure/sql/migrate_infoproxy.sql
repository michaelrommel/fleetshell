-- migrate_infoproxy.sql
--
-- Infoproxy (Services > Infoproxy): proxy (Squid) destination authorization.
-- See docs/product_admin.md section 4 + docs/mdm_status.md.
--
-- Model (three tables):
--   proxy_destination_rule_collection  -- a NAMED container of rules ("iPad Rule
--        Collection"). Pure administrative grouping; NOT an authz group. The
--        authz subsystem separately governs who may edit these (product-based).
--   proxy_destination_rule             -- ONE allowed target (cidr/dns + port
--        range + protocol). Belongs to exactly one collection. No scope here.
--   proxy_destination_binding          -- the SCOPE: applies a collection to a
--        device (NULL = ANY) and/or a product MODEL (NULL = ANY). One collection
--        can be bound many times (reused across models/devices).
--
-- Runtime: a spooler flattens binding -> collection -> rule into a per-source-IP
-- allow-list in Valkey; a Squid external_acl_type helper looks it up (O(1)) and
-- Squid caches the verdict. Device identity (modality/product/serial) is resolved
-- OFFLINE at spool time (Squid only sees the source IP at request time).
--
-- Idempotent; also folded into schema_global.sql. Apply against GLOBAL:
--   psql "$GLOBAL_WRITER_URL" -f migrate_infoproxy.sql

BEGIN;

-- Drop the earlier (superseded) shape if present -- scope-on-rule was wrong.
DROP TABLE IF EXISTS destination_rule;
DROP TABLE IF EXISTS destination_group;

-- A named container of rules. Reusable; referenced by many bindings.
CREATE TABLE IF NOT EXISTS proxy_destination_rule_collection (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    description text
);

-- One allowed target. A rule is ONLY the destination tuple -- no device/product
-- scope lives here (that is the binding's job).
CREATE TABLE IF NOT EXISTS proxy_destination_rule (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id    uuid NOT NULL REFERENCES proxy_destination_rule_collection(id) ON DELETE CASCADE,
    target_cidr      cidr,                                            -- IP or range (NULL = any host)
    target_dns       text,                                           -- destination host/domain
    target_port_from int,                                            -- NULL = any port
    target_port_to   int,                                            -- = from for a single port
    protocol         text NOT NULL,                                  -- 'CONNECT','HTTPS','HTTP','TCP',...
    -- a rule must name a destination by IP/range and/or DNS
    CHECK (target_cidr IS NOT NULL OR target_dns IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_proxy_rule_collection ON proxy_destination_rule(collection_id);

-- The scope: applies a collection to a device and/or a product MODEL.
--   device_id NULL  + product_id NULL  = ANY / ANY (global, all devices)
--   device_id set                      = that single device (single-system)
--   product_id set (kind='model')      = all devices of that model
-- A device matches a binding when
--   (device_id IS NULL OR device_id = D) AND (product_id IS NULL OR product_id = D's model).
CREATE TABLE IF NOT EXISTS proxy_destination_binding (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id uuid NOT NULL REFERENCES proxy_destination_rule_collection(id) ON DELETE CASCADE,
    device_id     uuid REFERENCES device(id)  ON DELETE CASCADE,   -- NULL = ANY device
    product_id    uuid REFERENCES product(id) ON DELETE CASCADE    -- NULL = ANY model; else kind='model'
);
CREATE INDEX IF NOT EXISTS ix_proxy_binding_collection ON proxy_destination_binding(collection_id);
CREATE INDEX IF NOT EXISTS ix_proxy_binding_product    ON proxy_destination_binding(product_id);
CREATE INDEX IF NOT EXISTS ix_proxy_binding_device     ON proxy_destination_binding(device_id);

COMMIT;
