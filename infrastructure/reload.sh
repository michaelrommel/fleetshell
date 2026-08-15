psql "$GLOBAL_WRITER_URL" -f sql/migrate_product_model.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_device_identity.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_gateway_enrich.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_data_classification.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_region_tree.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_dtm.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_customer_site.sql
psql "$GLOBAL_WRITER_URL" -f sql/migrate_authz_catalog.sql
psql "$LOCAL_WRITER_URL"  -f sql/migrate_user_country.sql
psql "$GLOBAL_WRITER_URL" -c "TRUNCATE region, product, gateway, device, customer, customer_site, principal_group, authz_role, authz_scope, authz_grant, dtm_matrix CASCADE;"
psql "$LOCAL_WRITER_URL"  -c "TRUNCATE app_user, login_account CASCADE;"
cd import
. .venv/bin/activate
python load.py --stage all
# Seed site membership (customer_site_member_static) from the imported
# device.site_id, so the rule-based resolver reproduces current memberships.
psql "$GLOBAL_WRITER_URL" -c "INSERT INTO customer_site_member_static (site_id, device_id) SELECT site_id, id FROM device WHERE site_id IS NOT NULL ON CONFLICT DO NOTHING;"
# Align device.customer_id with the site's customer (many imported rows have a
# site but a null customer_id) so the customer list can count by the indexed
# customer_id. Membership "recompute" keeps this in sync thereafter.
psql "$GLOBAL_WRITER_URL" -c "UPDATE device d SET customer_id = s.customer_id FROM customer_site s WHERE d.site_id = s.id AND d.customer_id IS DISTINCT FROM s.customer_id;"
python build_group_hierarchy.py && python build_group_hierarchy.py --apply
python seed_test_users.py
node seed_login_accounts.mjs | psql "$LOCAL_WRITER_URL"
cd ..
