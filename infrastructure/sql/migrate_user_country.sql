-- migrate_user_country.sql  (LOCAL plane: fleetshell_local)
--
-- Adds the persona's country (ISO-3166 alpha-2) to app_user. This is the
-- "user country" the Data Transfer Matrix needs: for a remote connection the
-- destination (TO) country is resolved per-service, and the accessing user's
-- country is one such input. It is imported from RDUSER.COUNTRYID (7733/7735
-- personas resolve to an ISO); later it may be sourced from the IdP (SAML/OAuth).
--
-- NOTE: home_region stays the regional VPC (e.g. 'eu-west-2'); country is the
-- geographic attribute, distinct from home_region.
--
-- Apply on the LOCAL cluster (each region) before load.py --stage users.

BEGIN;

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS country text;   -- ISO-3166 alpha-2, e.g. 'DE'
CREATE INDEX IF NOT EXISTS ix_user_country ON app_user(country);

COMMIT;
