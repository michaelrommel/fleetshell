-- migrate_user_pii.sql  (LOCAL plane: fleetshell_local)
--
-- Slice H (Option 1): human PII on the login_account (the person), imported from
-- RDUSER + RDUSERPROPERTY. NOT on the app_user persona -- the persona is only the
-- 'hat' (role_label / theme / is_admin / DTM country). Idempotent. Folded into
-- schema_local.sql; MUST run BEFORE load.py (stage_users writes these columns).

ALTER TABLE login_account ADD COLUMN IF NOT EXISTS phone           text;
ALTER TABLE login_account ADD COLUMN IF NOT EXISTS mobile          text;
ALTER TABLE login_account ADD COLUMN IF NOT EXISTS company         text;
ALTER TABLE login_account ADD COLUMN IF NOT EXISTS account_state   text;
ALTER TABLE login_account ADD COLUMN IF NOT EXISTS user_type       text;
ALTER TABLE login_account ADD COLUMN IF NOT EXISTS account_expires text;
