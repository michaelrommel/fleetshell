psql "$GLOBAL_WRITER_URL" -f sql/migrate_product_model.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_identity.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_gateway_enrich.sql
psql "$GLOBAL_WRITER_URL" -c "TRUNCATE region, product, gateway, device, customer, customer_site, principal_group, authz_role, authz_scope, authz_grant CASCADE;"
psql "$LOCAL_WRITER_URL"  -c "TRUNCATE app_user, login_account CASCADE;"
cd import
. .venv/bin/activate
python load.py --stage all
psql "$GLOBAL_WRITER_URL" -f ../sql/migrate_authz_catalog.sql
python build_group_hierarchy.py && python build_group_hierarchy.py --apply
python seed_test_users.py
node seed_login_accounts.mjs | psql "$LOCAL_WRITER_URL"
cd ..
