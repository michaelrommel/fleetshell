-- migrate_customer_site.sql  (GLOBAL plane: fleetshell)
--
-- Fills out the Customers / Sites page model (see docs/portal_ui.md):
--   * address fields (city / postcode / street) on customer + customer_site,
--   * created_at on both (deterministic tie-break for site membership),
--   * customer_site_contact (per-site contact list),
--   * resolve_site_membership(): materialize device.site_id from the three
--     assignment methods with a fixed precedence (see below).
--
-- Site membership model (decided): a device has ONE site_id. Three methods feed it:
--   1. manual   -> customer_site_member_static      (highest precedence, tier 3)
--   2. gateway  -> customer_site_rule dim=gateway_id (tier 2: all devices behind
--                  a gateway join the site)
--   3. hospital -> customer_site_rule dim=hospital_name (tier 1: device.hospital_name
--                  matches one of the listed names)
-- On overlap the higher tier wins; ties break by the site's created_at then id.
-- resolve_site_membership() recomputes the whole device table (admin action /
-- "Recompute membership" button) and is idempotent.
--
-- Apply on the global cluster (schema parts are pre-load safe). The one-time
-- seed of customer_site_member_static from the imported device.site_id runs
-- POST-load (see reload.sh) because it depends on loaded devices.

BEGIN;

ALTER TABLE customer      ADD COLUMN IF NOT EXISTS city       text;
ALTER TABLE customer      ADD COLUMN IF NOT EXISTS postcode   text;
ALTER TABLE customer      ADD COLUMN IF NOT EXISTS street     text;
ALTER TABLE customer      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE customer_site ADD COLUMN IF NOT EXISTS city       text;
ALTER TABLE customer_site ADD COLUMN IF NOT EXISTS postcode   text;
ALTER TABLE customer_site ADD COLUMN IF NOT EXISTS street     text;
ALTER TABLE customer_site ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS customer_site_contact (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id    uuid NOT NULL REFERENCES customer_site(id) ON DELETE CASCADE,
    name       text NOT NULL,
    role       text,
    email      text,
    phone      text,
    note       text,
    sort_order int  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_site_contact_site ON customer_site_contact(site_id);

-- Recompute device.site_id from static members + gateway/hospital rules, with
-- precedence (manual > gateway > hospital), ties by site created_at then id.
CREATE OR REPLACE FUNCTION resolve_site_membership() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    WITH candidate AS (
        SELECT m.device_id, m.site_id, 3 AS tier
        FROM customer_site_member_static m
        UNION ALL
        SELECT d.id, r.site_id, 2
        FROM customer_site_rule r
        JOIN device d ON d.gateway_id::text = ANY (r.values)
        WHERE r.dimension = 'gateway_id'
        UNION ALL
        SELECT d.id, r.site_id, 1
        FROM customer_site_rule r
        JOIN device d ON d.hospital_name = ANY (r.values)
        WHERE r.dimension = 'hospital_name'
    ),
    winner AS (
        SELECT DISTINCT ON (c.device_id) c.device_id, c.site_id, s.customer_id
        FROM candidate c
        JOIN customer_site s ON s.id = c.site_id
        ORDER BY c.device_id, c.tier DESC, s.created_at, s.id
    )
    UPDATE device d
    SET site_id = w.site_id, customer_id = w.customer_id
    FROM winner w
    WHERE w.device_id = d.id
      AND (d.site_id IS DISTINCT FROM w.site_id OR d.customer_id IS DISTINCT FROM w.customer_id);

    -- Devices that match no method any more lose their site (customer_id, which
    -- may be a direct assignment, is left untouched).
    UPDATE device d SET site_id = NULL
    WHERE d.site_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM customer_site_member_static m WHERE m.device_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM customer_site_rule r
                      WHERE r.dimension = 'gateway_id'   AND d.gateway_id::text = ANY (r.values))
      AND NOT EXISTS (SELECT 1 FROM customer_site_rule r
                      WHERE r.dimension = 'hospital_name' AND d.hospital_name = ANY (r.values));
END;
$$;

COMMIT;
