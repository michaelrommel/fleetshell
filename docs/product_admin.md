# Product Tree Administration — Design

Status: design agreed; not yet built. This is the spec for the `/products` page
(the primary sidebar section still stubbed) and a new top-level **Services**
section (its Infoproxy tab holds the proxy destination authorization). Read
`docs/portal_ui.md` (chrome + patterns) and `docs/mdm_design.md` (two-plane
model) first. Backing store: GLOBAL Aurora (`schema_global.sql`).

## 0. Product vs Product Model — naming cleanup

The tree has always conflated two distinct levels under the single word
"product". We fix that now, not later:

- **Product** = the level that carries a `family` and groups models. The whole
  **grant / scope structure built last session correctly scopes at the PRODUCT
  level** (`nlevel <= 3` in the Grants product picker, `subltree(path,0,2)` for
  modality) and stays as-is.
- **Product Model** = the new leaf level with the rich per-model attributes
  (partno, serial range, host flag, applications). Anything that stored
  model-ish attributes on a `product` row is moved to the model level.

Concretely: the old `product.partno / serial_from / serial_to` columns (all
`text`, always NULL because the importer never populated them) semantically
belonged to the **model**. They are **dropped from `product`** and re-homed as
`bigint` on `product_model` (§2), and — importantly — the model master data is
now actually **moved in** from the legacy `RDPRODUCTMODEL` table (partno,
integer serial range, host flag), which the old importer ignored entirely (§2.1).

## 1. Scope and levels

The product tree is a GLOBAL-plane `product` ltree. Today it is effectively
`root . modality . product` (the importer treats **modality = the level-2
label**, `subltree(path,0,2)`). We introduce a fourth level, **Product Model**,
below `product`:

```
root
  . modality        kind = modality   (fairly static, but editable)
    . product       kind = product    (+ family)
      . model        kind = model      (+ partno, serial range, host flag, apps)
```

- **Modality** — top level. Editable but rarely changes (CT, MR, ...).
- **Product** — gains one new attribute: **`family`** (free text, e.g.
  `Somatom57`, `SomatomX`, `Numaris4`). No other attributes beyond its parent.
- **Product Model** — the rich level:
  - `name` (text)
  - `partno` (integer)
  - `serial_from`, `serial_to` (integer min/max)
  - `is_host_computer` (boolean)
  - **applications** — the Connect-app list (§3)
  - device authorization — **NOT stored here**; central Services section (§4)

`device.product_path` points at a **model** node after migration (§2/§7).

### Decision: new level below products

Existing leaf product nodes stay `kind='product'`; **model nodes are added
beneath them** (nlevel 4). The models are real legacy master data, imported from
`RDPRODUCTMODEL` (§2.1). Devices still reference the **product** level in the
legacy data; re-pointing `device.product_path` to the matching model (by serial
range, §5) is a follow-up migration.

## 2. Schema changes

### Canonical (`schema_global.sql`) — already updated

`product` no longer carries `partno / serial_from / serial_to`; it gains `kind`
and `family`. Two satellites are added:

```sql
CREATE TABLE product (
    id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    path   ltree NOT NULL,              -- id-based: modality.product.model
    kind   text  NOT NULL DEFAULT 'product'
           CHECK (kind IN ('modality','product','model')),
    family text,                        -- only meaningful on kind='product'
    name   text  NOT NULL DEFAULT ''
);

-- Model-level typed attributes (1:1 with a kind='model' product node).
CREATE TABLE product_model (
    product_id       uuid PRIMARY KEY REFERENCES product(id) ON DELETE CASCADE,
    partno           bigint,
    serial_from      bigint,          -- inclusive lower bound (integer serials)
    serial_to        bigint,          -- inclusive upper bound
    is_host_computer boolean NOT NULL DEFAULT false
);

-- The Connect-application defaults for a model (mirrors the client AppProfile).
CREATE TABLE product_model_app (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,  -- the model node
    name        text NOT NULL,
    application text NOT NULL
                CHECK (application IN ('http','https','expert-i','rdp','vnc','ssh')),
    ports       text NOT NULL DEFAULT '',   -- '3389' or a range like '3000-3020'
    guac        boolean NOT NULL DEFAULT false,
    e2ecrypt    boolean NOT NULL DEFAULT false,
    sni         text NOT NULL DEFAULT '',
    path        text NOT NULL DEFAULT '/',
    width       int  NOT NULL DEFAULT 1920,
    height      int  NOT NULL DEFAULT 1080,
    dpi         int  NOT NULL DEFAULT 96,
    drive       boolean NOT NULL DEFAULT false,
    record      boolean NOT NULL DEFAULT false,
    sort_order  int  NOT NULL DEFAULT 0
);
```

`product_model_app` is column-for-column identical to the client's `AppProfile`
(`fleetshell-portal/.../devices/+page.svelte`) so a **single app-editor
component** serves both the product-model page and the device page.

### Live DB (`migrate_product_model.sql`)

Applied against the running GLOBAL cluster (also re-applied after a data reload,
alongside `migrate_authz_catalog.sql`, since a fresh `load.py` recreates
`product`): drops the three columns, adds `kind` + `family`, classifies existing
rows by depth (`nlevel=2` -> modality, `=3` -> product, `>=4` -> model), and
creates the two satellites.

### 2.1. Importing the model master data (`load.py`)

The legacy export has a real **`RDPRODUCTMODEL`** table (1386 rows) linked to
`RDPRODUCT` via `PRODUCTID`; the old importer never touched it (hence the NULL
columns). `load.py` now, in `stage_reference`:

- sets `kind` on each RDPRODUCT node by depth (modality <= L2, product = L3);
- for each model, creates a `kind='model'` product node under its product
  (path `product_path.<model_id>`, nlevel 4, `model_map` UUID) and a 1:1
  `product_model` satellite: `partno = PARTNUMBER`, `serial_from = SERIALFROM`,
  `serial_to = SERIALTO`, `is_host_computer = (SYSTEMHOST = '1')`.

Model names are catalog data (not PII), kept verbatim. Serial ranges stay REAL
(they are catalog bounds); note device serials are anonymized, so demo devices
do not fall in these ranges. `RDPRODUCTMODEL` carries far more fields
(OS, service SW, network/router flags, REST URL, ...) — only the four in scope
are imported now; the rest can be added to `product_model` when needed.

## 3. Applications list and device inheritance

### Decision: live inherit + full per-device override

A device does not copy the model's apps. It **inherits by reference** and may
**replace the whole list** with its own rows:

```
resolve_apps(device):
    if device has device_app rows -> use them (full override)
    else                          -> use product_model_app(device.product_id)
```

- Editing a model's `product_model_app` list **propagates live** to every device
  that has not overridden — the fleet-management win.
- The device page (built later) writes `device_app` rows only when an admin
  chooses to override; a "revert to model defaults" action deletes them.
- `device_app` has the **same columns** as `product_model_app` plus `device_id`
  (defined with the device-page spec).

The product-model page owns only `product_model_app`. Devices are out of scope
here.

## 4. Device Authorization — Services > Infoproxy (NOT the model page)

### Decision: central section, own top-level nav

Proxy/email/file destination authorization lives under a new **top-level
Services** section, not on the product-model page. Services is a tabbed section:

| Tab | Service |
|---|---|
| **Infoproxy** | proxy destination authorization (this spec's rules) |
| **E-Mail Relay** | mail relay authorization (separate service) |
| **File Transfer** | file transfer authorization (separate service) |

Infoproxy is **filterable by product model**. The product-model page shows **no
embedded table** — only a deep link:

> `View destinations for this model →`  ( `/services/infoproxy?product=<model_id>` )

Rationale: the legacy platform has ~2226 rules with a long tail (≈40 ANY/ANY,
the bulk per single system, ≈150 per-model/ANY). A filterable central table
scales; a per-model embedded editor does not, and one rule is often shared
across models.

A rule is `(device | ANY, product-model | ANY, target IP/range, target DNS,
target port, protocol, authorization group)`; rules aggregate into named
**Authorization Groups** referenced by many rules. Proposed schema (built with
the Services section, not now):

```sql
CREATE TABLE destination_group (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    description text
);

CREATE TABLE destination_rule (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id      uuid REFERENCES device(id)  ON DELETE CASCADE,   -- NULL = ANY device
    product_id     uuid REFERENCES product(id) ON DELETE CASCADE,   -- NULL = ANY model; else kind='model'
    target_cidr    cidr,                                            -- IP or range
    target_dns     text,
    target_port_from int,
    target_port_to   int,                                          -- = from for a single port
    protocol       text NOT NULL,                                  -- 'CONNECT','HTTPS','HTTP','TCP',...
    group_id       uuid REFERENCES destination_group(id) ON DELETE SET NULL
);
```

When Infoproxy is filtered by a product model it shows rules where
`product_id = <model>` **OR** `product_id IS NULL` (ANY), matching the legacy
model-dialog semantics (globally-valid + this-model rules; excludes
device-specific and other-model rules). Central editing; the model page is a
read-only entry point via the deep link.

## 5. Serial-range rule (device-create, cross-reference)

Device serials stay **text** (`device.attrs->>'serial'`; legacy serials can be
alphanumeric). The model bounds are **integers** (`product_model.serial_from/to`).
On device creation (device page, later):

```
S := device serial (text)
if S ~ '^[0-9]+$' and model has serial_from/serial_to:
    require serial_from <= S::bigint <= serial_to
else:
    range check DISABLED (alphanumeric serial, or unbounded model)
```

This validation belongs to the device-create flow, not the product page; it is
recorded here because the bounds are authored on the model.

## 6. UI (`/products`)

Master-detail, reusing the `GroupTree.svelte` pattern (consider extracting a
generic `Tree.svelte`; the group tree is the reference implementation):

- **Left**: expandable product tree (modality -> product -> model), grant-style
  filter revealing matches + ancestors; node badges show `kind` and child count.
- **Right**, per selected node kind:
  - **modality**: rename; add child product; delete (guarded if it has children
    or devices).
  - **product**: rename; **family** field; add child model; delete (guarded).
  - **model**: `name`, `partno` (int-validated), `serial_from`/`serial_to`
    (int-validated, from <= to), `is_host_computer`; the **applications editor**
    (the shared `AppProfile` list editor — add/remove/reorder rows, per-row
    conditional fields: guac/e2e for rdp/vnc/ssh, sni/path for http-family,
    drive for rdp, record for guac); a **`View destinations for this model →`**
    deep link to `/services/infoproxy?product=<id>` (§4); delete (guarded if
    devices reference it).

Every write goes through `authz_can(persona, <verb>, product)` server-side in
the `+page.server.ts` action (§8 of `portal_ui.md`); admin-gated like the rest
of the section for now. The `product` resource type + CRUD verbs already exist
in the authz catalog (`migrate_authz_catalog.sql`).

## 7. Build order

1. `migrate_product_model.sql` — drop old columns, add `kind`+`family`, classify
   rows, create `product_model` + `product_model_app`. **DONE (schema written).**
2. `/products` tree + detail panels (modality/product) — read then edit.
   **DONE** (`ProductTree.svelte` + `products/+page.*`).
3. Model detail + the shared `AppProfile` applications editor. **DONE**
   (`AppEditor.svelte`; `product_model_app` CRUD).
4. Device re-pointing migration + device-page override (`device_app`) — with the
   device page.
5. **Services** top-level section (own schema, own tree/filter): Infoproxy first,
   then E-Mail Relay and File Transfer — after the product tree lands, since
   Infoproxy references model nodes. The model page already deep-links to
   `/services/infoproxy?product=<id>` (currently a dead link until built).
