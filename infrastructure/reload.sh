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
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_gateway_spool.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_service_key.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_app.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_authz_catalog.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_services_authz.sql

step "Local schema migrations"
psql "$LOCAL_WRITER_URL"  -f sql/migrate_user_country.sql
psql "$LOCAL_WRITER_URL"  -f sql/migrate_user_pii.sql

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

step "Gateway authz: region_path backfill + visible/list/can functions"
# Needs gateway + region populated (backfills gateway.region_path by name), so
# it runs AFTER the import. Idempotent. (cwd is import/ here -> ../sql.)
psql "$GLOBAL_WRITER_URL" -f ../sql/migrate_gateway_authz.sql

step "Group hierarchy"
# Groups + their parent/path hierarchy + memberships now come straight from the
# normalized RDUSERGROUP/RDUSER2GROUP tables inside load.py stage_grants (Slice
# C), so build_group_hierarchy.py + groups.txt are obsolete. Nothing to do here.
echo "  (imported from RDUSERGROUP by load.py -- build_group_hierarchy.py retired)"

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

step "Flush portal authz cache (Valkey)"
# A full reload mints fresh group/scope UUIDs, so every portal L0/L1 cache entry
# is now stale (esp. authz:groups:<userId>, which survives a gen bump because it
# is per-user, not per-generation). Drop the authz cache keys so the portal
# re-resolves against the new data. Scoped delete (NOT flushdb) so the Valkey
# spool keys (systems:by-ip, fleetipsec, dtm, data_classes, ftp_subscriptions,
# infoproxy) are left intact. Best-effort: never fail the reload on this.
VALKEY_URL="${VALKEY_URL:-rediss://localhost:6380}"
if command -v redis-cli >/dev/null 2>&1; then
  VPORT="$(printf '%s' "$VALKEY_URL" | sed -E 's#.*:([0-9]+).*#\1#')"; VPORT="${VPORT:-6380}"
  VTLS=""; case "$VALKEY_URL" in rediss://*) VTLS="--tls --insecure";; esac
  for pat in 'authz:*' 'list:dev:*' 'list:gw:*' 'count:dev:*' 'count:gw:*'; do
    # SCAN + DEL in one pipe; quote the pattern; ignore errors.
    redis-cli $VTLS -p "$VPORT" --scan --pattern "$pat" 2>/dev/null \
      | xargs -r redis-cli $VTLS -p "$VPORT" DEL >/dev/null 2>&1 || true
  done
  echo "  flushed authz:* / list:* / count:* (spool keys preserved)"
else
  echo "  redis-cli not found -- flush skipped; restart the portal or wait out the TTL"
fi

step "Reload complete"
