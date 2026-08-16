-- migrate_persona_rename.sql
--
-- Terminology consistency: the account<->authz-subject link is a PERSONA link,
-- so rename account_identity -> account_persona (and its indexes) to match the
-- portal (docs/portal_ui.md) and the app_user "persona" naming everywhere.
--
-- Only needed on DBs created before this rename (i.e. that already ran
-- migrate_identity_local.sql + migrate_identity_primary.sql). Fresh installs
-- from schema_local.sql already have account_persona. Idempotent via IF EXISTS.
--
--   psql "$LOCAL_WRITER_URL" -f migrate_persona_rename.sql

BEGIN;

ALTER TABLE IF EXISTS account_identity RENAME TO account_persona;
ALTER INDEX IF EXISTS ix_identity_account RENAME TO ix_account_persona_account;
ALTER INDEX IF EXISTS ix_identity_user    RENAME TO ix_account_persona_user;
ALTER INDEX IF EXISTS ux_identity_primary RENAME TO ux_account_persona_primary;

COMMIT;

-- Note: foreign-key / primary-key constraint names keep their old auto-generated
-- form (account_identity_*). They still function; renaming them is cosmetic and
-- intentionally skipped.
