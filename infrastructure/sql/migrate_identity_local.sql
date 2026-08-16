-- migrate_identity_local.sql
--
-- LOCAL plane: introduce the person/persona split and the region-prefixed
-- user_id scheme (see docs/portal_ui.md "Identity model").
--
--   * app_user            -> the persona (authz subject). user_id becomes text
--                            ('eu:123'); gains role_label (display) + is_admin
--                            (interim capability gate for the Administration UI).
--   * login_account       -> the human who authenticates (username/email +
--                            password now, SAML/OAuth internal id later).
--   * account_identity     -> N:M: which personas a person may assume.
--
-- The GLOBAL plane is untouched: only group_id (uuid) crosses to authz, never
-- user_id, so changing user_id's type has no authz-function impact.
--
-- Idempotent where practical. The user_id type change rewrites group_membership
-- (~1M rows); a few seconds on Aurora. Apply once to an existing local DB:
--   psql "$LOCAL_WRITER_URL" -f migrate_identity_local.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. user_id  uuid -> text  (region-prefixed scheme). Drop the FK, retype both
--    sides + added_by, then re-add the FK. Existing UUIDs keep their text form.
ALTER TABLE group_membership DROP CONSTRAINT IF EXISTS group_membership_user_id_fkey;
ALTER TABLE app_user         ALTER COLUMN user_id  TYPE text USING user_id::text;
ALTER TABLE group_membership ALTER COLUMN user_id  TYPE text USING user_id::text;
ALTER TABLE group_membership ALTER COLUMN added_by TYPE text USING added_by::text;
ALTER TABLE group_membership
    ADD CONSTRAINT group_membership_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE;

-- 2. Persona display + interim capability columns.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS role_label text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_admin   boolean NOT NULL DEFAULT false;

-- The persona no longer owns the login email (that moves to login_account);
-- relax it so test personas need not carry a unique address.
ALTER TABLE app_user ALTER COLUMN email DROP NOT NULL;
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_email_key;

-- 3. Sequence for new region-prefixed personas: user_id = '<region>:<n>'.
CREATE SEQUENCE IF NOT EXISTS app_user_local_seq;

-- 4. The human login account.
CREATE SEQUENCE IF NOT EXISTS login_account_seq;
CREATE TABLE IF NOT EXISTS login_account (
    account_id    text PRIMARY KEY,           -- opaque, e.g. 'acct:eu:1'
    username      text UNIQUE NOT NULL,        -- internal username (SAML/OAuth id later)
    email         text UNIQUE NOT NULL,
    password_hash text,                        -- scrypt$...; null once IdP owns auth
    display_name  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 5. Which personas a person may assume (N:M). The identity selector reads this.
CREATE TABLE IF NOT EXISTS account_identity (
    account_id text NOT NULL REFERENCES login_account(account_id) ON DELETE CASCADE,
    user_id    text NOT NULL REFERENCES app_user(user_id)         ON DELETE CASCADE,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_identity_account ON account_identity(account_id);
CREATE INDEX IF NOT EXISTS ix_identity_user    ON account_identity(user_id);

COMMIT;
