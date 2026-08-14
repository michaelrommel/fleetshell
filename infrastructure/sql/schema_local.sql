-- schema_local.sql
--
-- REGIONAL (LOCAL) data plane -- standalone Aurora cluster, stays in-region.
-- Holds ONLY the identity data that must not replicate worldwide:
--   * login accounts (the human who authenticates)
--   * personas (app_user: the authz subject) + their PII
--   * group membership (persona <-> group)
--
-- The hot authorization path resolves persona -> groups HERE (local, fast); the
-- resulting group_ids are then evaluated against the GLOBAL authz model
-- (schema_global.sql), which is replicated read-only into every region.
--
-- IDs: user_id (persona) is region-prefixed text, e.g. 'eu:123' (globally unique
-- by construction). group_id is a CROSS-DATABASE reference to principal_group in
-- the global plane, so there is NO SQL FK to it. Only group_id ever crosses to
-- the authz plane; user_id stays local.
--
-- Person vs persona: a login_account (one human) may assume several app_user
-- personas via account_persona (N:M). After login, if more than one persona is
-- linked, the portal shows an Identity Selector. See docs/portal_ui.md.
--
-- Apply with:  psql "$LOCAL_WRITER_URL" -f schema_local.sql
-- Existing DBs from the pre-identity schema: use migrate_identity_local.sql.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- New personas get user_id = '<region>:<n>' from this sequence.
CREATE SEQUENCE IF NOT EXISTS app_user_local_seq;
CREATE SEQUENCE IF NOT EXISTS login_account_seq;

-- The persona: the authorization subject. All identifying attributes live only
-- in this region.
CREATE TABLE IF NOT EXISTS app_user (
    user_id       text PRIMARY KEY,           -- region-prefixed, e.g. 'eu:123'
    home_region   text NOT NULL,             -- should match this cluster's region
    firstname     text NOT NULL,
    lastname      text NOT NULL,
    email         text,                       -- optional contact; login email is on login_account
    gender        text,                       -- self-described; free text / enum later
    address_style text,                       -- how they like to be addressed
    role_label    text,                       -- display-only role name (e.g. 'SuperUser'); NOT authz
    is_admin      boolean NOT NULL DEFAULT false, -- interim gate for the Administration UI (replace with authz_can)
    theme         text,                       -- per-user UI theme override (nucleus|gruvbox)
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_user_email ON app_user(email);

-- The human who authenticates. Password now; SAML/OAuth internal id later.
CREATE TABLE IF NOT EXISTS login_account (
    account_id    text PRIMARY KEY,           -- opaque, e.g. 'acct:eu:1'
    username      text UNIQUE NOT NULL,
    email         text UNIQUE NOT NULL,
    password_hash text,                        -- scrypt$...; null once IdP owns auth
    display_name  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Which personas a person may assume (N:M). The identity selector reads this.
-- Exactly one linked persona per account is the PRIMARY (default) identity:
-- always present, cannot be unlinked in the UI.
CREATE TABLE IF NOT EXISTS account_persona (
    account_id text NOT NULL REFERENCES login_account(account_id) ON DELETE CASCADE,
    user_id    text NOT NULL REFERENCES app_user(user_id)         ON DELETE CASCADE,
    is_primary boolean NOT NULL DEFAULT false,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_account_persona_account ON account_persona(account_id);
CREATE INDEX IF NOT EXISTS ix_account_persona_user    ON account_persona(user_id);
-- At most one primary persona per account.
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_persona_primary
    ON account_persona(account_id) WHERE is_primary;

-- Membership: group_id references principal_group in the GLOBAL plane
-- (cross-DB, so no FK). One row per (group, persona).
CREATE TABLE IF NOT EXISTS group_membership (
    group_id uuid NOT NULL,                   -- -> global principal_group.group_id (cross-DB, no FK)
    user_id  text NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
    added_by text,                            -- opaque user_id of the group admin
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
-- Hot path is persona -> groups, so index by user first.
CREATE INDEX IF NOT EXISTS ix_membership_user  ON group_membership(user_id);
CREATE INDEX IF NOT EXISTS ix_membership_group ON group_membership(group_id);

COMMIT;
