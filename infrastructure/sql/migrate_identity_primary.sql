-- migrate_identity_primary.sql
--
-- Adds the "default persona" notion to the person/persona link: each
-- login_account has exactly one PRIMARY persona (its own identity, always
-- present, non-unlinkable in the UI) plus optional additional linked personas.
--
-- See docs/portal_ui.md "Identity model". Apply once, after
-- migrate_identity_local.sql:
--   psql "$LOCAL_WRITER_URL" -f migrate_identity_primary.sql

BEGIN;

ALTER TABLE account_identity ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

-- At most one primary persona per account.
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_primary
    ON account_identity(account_id) WHERE is_primary;

-- Backfill: for any account with no primary yet, promote its lowest user_id.
UPDATE account_identity ai
SET is_primary = true
WHERE ai.user_id = (
        SELECT x.user_id FROM account_identity x
        WHERE x.account_id = ai.account_id
        ORDER BY x.user_id LIMIT 1
      )
  AND NOT EXISTS (
        SELECT 1 FROM account_identity y
        WHERE y.account_id = ai.account_id AND y.is_primary
      );

COMMIT;
