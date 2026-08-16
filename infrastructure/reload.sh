#!/usr/bin/env bash
#
# Full reload of the FleetShell MDM dev clusters from the legacy exports.
# Migrations are idempotent (ADD COLUMN IF NOT EXISTS etc.), so this is safe to
# re-run. Expects GLOBAL_WRITER_URL / LOCAL_WRITER_URL in the environment.
#
# Anonymized dev seeding is the default. For the REAL data take-over, run the
# exact same script with the anonymizer switched off:
#     ANONYMIZE=0 ./reload.sh
# (every field then passes through raw instead of being faked/placeholdered).

set -euo pipefail

: "${GLOBAL_WRITER_URL:?set GLOBAL_WRITER_URL}"
: "${LOCAL_WRITER_URL:?set LOCAL_WRITER_URL}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

step "Global schema migrations"
psql "$GLOBAL_WRITER_URL" -f sql/migrate_product_model.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_identity.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_tunnel_gateway.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_ops_notify.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_gateway_enrich.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_data_classification.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_region_tree.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_dtm.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_customer_site.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_file_subscriptions.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_infoproxy.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_authz_catalog.sql

step "Local schema migrations"
psql "$LOCAL_WRITER_URL"  -f sql/migrate_user_country.sql

step "Truncate global + local data"
psql "$GLOBAL_WRITER_URL" -c "TRUNCATE region, product, gateway, device, customer, customer_site, principal_group, authz_role, authz_scope, authz_grant, dtm_matrix CASCADE;"
psql "$LOCAL_WRITER_URL"  -c "TRUNCATE app_user, login_account CASCADE;"

step "Import (load.py --stage all)  [ANONYMIZE=${ANONYMIZE:-1}]"
cd import
. .venv/bin/activate
python load.py --stage all

step "Seed site membership + align device.customer_id"
# Seed customer_site_member_static from the imported device.site_id, so the
# rule-based resolver reproduces current memberships.
psql "$GLOBAL_WRITER_URL" -c "INSERT INTO customer_site_member_static (site_id, device_id) SELECT site_id, id FROM device WHERE site_id IS NOT NULL ON CONFLICT DO NOTHING;"
# Align device.customer_id with the site's customer (many imported rows have a
# site but a null customer_id) so the customer list can count by customer_id.
psql "$GLOBAL_WRITER_URL" -c "UPDATE device d SET customer_id = s.customer_id FROM customer_site s WHERE d.site_id = s.id AND d.customer_id IS DISTINCT FROM s.customer_id;"

step "Materialize group hierarchy"
python build_group_hierarchy.py && python build_group_hierarchy.py --apply

step "Import file subscriptions (servers + subscriptions + attach matrix)"
# Re-resolves modality/product FKs by NAME; a `product` TRUNCATE CASCADE above
# emptied subscription + subscription_server, so this rebuilds them. Honors
# ANONYMIZE like load.py. Reads the gitignored xlsx from old_database/.
IMPORT_GLOBAL_DSN="$IMPORT_GLOBAL_DSN" ANONYMIZE="${ANONYMIZE:-1}" python import_subscriptions.py

step "Import infoproxy (proxy destination collections + rules + bindings)"
# Reads the legacy Info Proxy exports (gitignored, old_database/) + the
# sysname_device.map.json written by stage_devices above, to attribute the
# per-Customer-System proxy bindings to the right (anonymized) device. A
# `product` TRUNCATE CASCADE emptied proxy_destination_binding; this rebuilds
# collections/rules/bindings from scratch.
IMPORT_GLOBAL_DSN="$IMPORT_GLOBAL_DSN" python import_infoproxy.py

step "Seed test users + login accounts"
python seed_test_users.py
node seed_login_accounts.mjs | psql "$LOCAL_WRITER_URL"

cd ..
step "Reload complete"
