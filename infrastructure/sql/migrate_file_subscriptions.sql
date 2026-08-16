-- migrate_file_subscriptions.sql
--
-- File Subscriptions (Services > File Subscriptions): defines WHERE device files
-- are delivered (Subscriber Servers) and WHICH files match (Subscriptions), with
-- an N:M attach matrix between them.
--
-- None of these fields existed in the legacy dataset -- all master data is
-- authored in the portal. Delivery-target secrets (client secret, passwords,
-- account/secret keys) live PLAINTEXT in the `auth` jsonb, matching the existing
-- gateway IPsec PSK precedent. Harden later (Secrets Manager) as a separate pass.
--
-- Idempotent; also folded into schema_global.sql. Apply against GLOBAL:
--   psql "$GLOBAL_WRITER_URL" -f migrate_file_subscriptions.sql

BEGIN;

-- A delivery target. `delivery_method` picks the transport; `auth` carries the
-- method-specific connection + credentials (shape documented below).
--
--   delivery_method = 'adls':
--     { "method": "service_principal",
--       "storage_account": "...", "tenant_id": "...",
--       "client_id": "...", "client_secret": "..." }
--     { "method": "default",
--       "account_url": "...", "account_name": "...", "account_key": "..." }
--   delivery_method = 's3':
--     { "method": "access_key",
--       "access_key_id": "...", "secret_access_key": "...",
--       "region": "...", "endpoint": "..." }          -- endpoint optional (S3-compatible)
--     { "method": "assume_role",
--       "role_arn": "...", "external_id": "...", "region": "..." }
--   delivery_method = 'scp':
--     { "username": "...", "password": "..." }
CREATE TABLE IF NOT EXISTS subscriber_server (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name              text NOT NULL,
    ip_address        text,                    -- host we connect to (legacy source of truth)
    country           text,                    -- ISO country code (nullable)
    use_case          text NOT NULL DEFAULT 'internal'
                      CHECK (use_case IN ('compliance','internal')),
    comment           text,                    -- legacy annotation (contacts/purpose)
    activated         boolean NOT NULL DEFAULT false,
    delivery_method   text NOT NULL
                      CHECK (delivery_method IN ('adls','s3','scp')),
    root_path         text,
    use_partno_folder boolean NOT NULL DEFAULT false,
    container_path    text,                    -- "Container or Sub Path"
    auth              jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (name)
);
-- Idempotent add for DBs created before `ip_address` existed.
ALTER TABLE subscriber_server ADD COLUMN IF NOT EXISTS ip_address text;

-- A file matcher. modality/product are optional narrowing filters (a NULL means
-- "any"). `pattern` is a PCRE regex; `negate` flips a matcher into an exclusion
-- (used to carve a specific subset out of an overly broad earlier subscription).
CREATE TABLE IF NOT EXISTS subscription (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    modality_id uuid REFERENCES product(id) ON DELETE SET NULL,   -- kind='modality'; NULL = any
    product_id  uuid REFERENCES product(id) ON DELETE SET NULL,   -- kind='product';  NULL = any
    pattern     text NOT NULL,
    negate      boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS ix_subscription_modality ON subscription(modality_id);
CREATE INDEX IF NOT EXISTS ix_subscription_product  ON subscription(product_id);
-- The annotation lives on subscriber_server (it is consistent per server, not
-- per subscription); drop a stray subscription.comment from earlier DBs.
ALTER TABLE subscription DROP COLUMN IF EXISTS comment;

-- N:M attach matrix: one subscription delivers to many subscriber servers.
CREATE TABLE IF NOT EXISTS subscription_server (
    subscription_id uuid NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
    server_id       uuid NOT NULL REFERENCES subscriber_server(id) ON DELETE CASCADE,
    PRIMARY KEY (subscription_id, server_id)
);
CREATE INDEX IF NOT EXISTS ix_subscription_server_server ON subscription_server(server_id);

COMMIT;
