# Data Classification -- Design

Status: implemented (schema + import pipeline + UI all built and loaded). Read
`docs/product_admin.md` (product tree) and `docs/mdm_design.md` (authz model)
first. Backing store: GLOBAL Aurora (`schema_global.sql`); the resolved result is
mirrored into Valkey for aeroftp.

## 1. What it is

Data classification assigns **data classes** to files produced by a device,
based on the **filename**. A classification rule is a regular expression matched
against a filename; when it matches, the file carries that rule's set of data
classes. Rules are scoped per **(modality, product)** -- exactly the Valkey key
`data_classes:<MODALITY>:<PRODUCT>` that aeroftp already consumes.

The legacy input is an Excel sheet: `Modality | Product | Filename Regex` then
one yes/no column per data class. The bulk of the rows are duplicated across
products (e.g. `.*FTPDummy\.tmp -> DSH` repeated for ~20 XP products; an 11-row
Precheck/Boot block repeated verbatim across ~7 products). Only the
partno-bearing rows are genuinely product-specific. This tool replaces the
copy/paste with **author-once Rule Sets + a Mapping**.

## 2. The fixed data classes

Eight, fixed (`data_class` lookup table, seeded):

| Code | Label |
|---|---|
| PHI | Protected Health Information |
| UPD | Utilization & Performance Data |
| RD  | Result Data |
| PII | Personal Identifiable Information |
| ACD | Asset & Configuration Data |
| DSH | Device Service History |
| TSD | Technical Status Data |
| STD | Smart Technical Data |

## 3. Model: Rule Sets + Assignments

Two concepts, both **owned by a modality** (a BU Representative owns their
modality end to end -- see authz below):

- **Rule Set** -- a named, reusable bundle of rules. A **rule** = one regex + the
  set of data classes it carries. Example sets in XP: `FTP/SFTP Dummy` (2 rules,
  all DSH), `XP Boot/Precheck` (11 rules, all DSH), `Common Eventlog`.
- **Assignment** -- attaches a Rule Set to a target within the same modality:
  - a **product** (`product_id`, kind='product'), or
  - a **family** (`product.family` value -- fans out to every product with that
    family), or
  - **modality-wide** (both NULL -- applies to every product in the modality).

A product's own partno-specific rules are just a Rule Set assigned only to that
product (product-private set). It should be rare; the UI shows it inline rather
than as a reusable chip, but storage and the resolver treat it identically.

### Resolution (DB -> Valkey)

For each product P in modality M, the effective rule list is the union of every
Rule Set assigned to P -- directly, via P's `family`, or modality-wide. Per
regex, union the data-class codes across all contributing rules. Emit into the
Valkey hash `data_classes:<M>:<P.name>`:

```
field = /<regex>/            (slash-delimited, matching the legacy format)
value = CODE,CODE,...        (the union of 'yes' classes; deterministic order)
```

An empty union (no assignments) means the product key is absent / removed.

## 4. Authorization

Data classification is **part of editing the product tree** -- no new verb, no
new resource type. It is gated by **`product:edit`**, scoped by `product_path`
subtree, and the meaningful boundary is the **modality**:

- A BU Representative holds `product:edit` over their modality subtree and may
  create products/models AND author + assign classification within it.
- Central admins hold it over the root (and thus every modality).

Because Rule Sets are modality-owned and assignments stay within the modality,
one modality-scoped grant covers the whole feature; nothing crosses modalities.

**Phase 1** gates on the interim `is_admin` persona flag (identical to
`/products` and Administration today). When the section-wide non-device
`authz_can(persona, verb, product_node)` lands, every product-tree write --
structure, models, apps, and classification -- flips to real `product:edit` in
one migration.

## 5. Schema (global plane)

See `infrastructure/sql/migrate_data_classification.sql` (idempotent; also folded
into `schema_global.sql`).

```
data_class(code PK, label, sort_order)                         -- fixed 8, seeded
classification_set(id, modality_id -> product, name, description, UNIQUE(modality,name))
classification_rule(id, set_id -> set, regex, sort_order)      -- regex WITHOUT slashes
classification_rule_class(rule_id -> rule, code -> data_class, PK(rule,code))
classification_assignment(id, set_id -> set, product_id? -> product, family? text)
    -- CHECK: at most one of (product_id, family) is set; both NULL = modality-wide
```

`regex` is stored **without** the surrounding `/.../`; the slashes are a Valkey
serialization detail added at sync time.

## 6. UI (`/products/classification`)

The Products section is tabbed (`Product Tree | Data Classification`). The
Data Classification tab is modality-scoped (a modality picker) with three inner
views:

- **Rule Sets** -- master/detail: pick a set, edit its rules in an Excel-like
  grid (regex column + 8 class checkboxes), add/remove/reorder rows. Create,
  rename, delete sets.
- **Assignments** -- a matrix for the modality: rows = products (grouped by
  family, with a tickable family header and a modality-wide row), columns =
  Rule Sets; tick a cell to assign. Product-private sets appear inline on the
  product row.
- **Preview** -- the effective, merged `/<regex>/ -> CODES` list per product
  exactly as it will be written to Valkey, plus a **Sync to Valkey** action.

Every write goes through the same admin gate as the rest of the section (Phase 1
`is_admin`).

## 7. Bulk import + reload survival

The legacy source is `Data_Classification_fleetshell.xlsx` (one sheet per
modality; kept in `infrastructure/import/old_database/`, gitignored). The
pipeline turns it into a committed, **name-keyed** artifact that survives a full
`old_database` reload (which regenerates every `product` UUID), because the
artifact references products/families by NAME, not id.

```
Data_Classification_fleetshell.xlsx
        |  classification_dedup.py      (DB-free, deterministic)
        v
classification.json  <----------------  classification_export.py   (DB -> file)
        |  load.py --stage classification (file -> DB, by name)
        v
   GLOBAL Aurora (classification_* tables)
```

- **`classification_dedup.py`** reads the xlsx and writes `classification.json`
  (+ a `product_families.json` template, if absent, listing the distinct CT/MR
  platform strings to map products onto). Columns are located by header NAME
  (MR has an extra Subscription column that shifts the layout). A cell is
  "checked" unless empty or an explicit negative (`no`/`x`/blank/... handled).
  Rules with no class or no regex are dropped. Regexes are imported verbatim
  (the source has globs and typos; not our job to fix).
- **Dedup = lossless support-based partition**: a rule = `(regex, codes)`; its
  support = the set of targets carrying it; rules with identical support become
  one Rule Set assigned to exactly those targets. Sets are auto-named from the
  common regex token (rough on purpose -- rename in the UI).
- **Modality is keyed by the row's Modality COLUMN, not the sheet name.** A BU
  may author rules for a product that lives in another BU's tree (the AX sheet's
  four Cios rows -- `Cios Connect`, `Cios Fusion`, `Cios_Alpha_VA20`,
  `Cios_Select_VA10` -- carry Modality column = `XP` because those former-XP
  products are still parented under XP for the external device sync). Keying by
  the column routes those rules into XP automatically; the AX BU maintains them
  on the AX sheet with the XP modality set.
- **CT and MR are family-based**: their sheet "Product" column is a platform
  (Somaris 5/7/10/X, Numaris 4/X) stored as a `family` assignment. These are
  dormant (resolve to zero products) until `product.family` is populated to
  match those exact strings -- then they light up with no re-import.

### Populating product.family (`product_families.json`)

Family assignments resolve only when `product.family` string-matches the family
name. `product_families.json` is the committed, name-keyed mapping
`{ modality: { family: [product names] } }`. `load.py --stage families` applies
it (per-modality reset then set), keyed by NAME so it survives a reload; it runs
automatically in `--stage all`, **before** the classification stage.

- A family listed as `["*"]` is a **modality default** -- it tags every product
  in the modality. Explicit product lists are applied **after** wildcards, so a
  named product always overrides the default (e.g. MR: `Numaris 4/X: ["*"]` tags
  all MR products, then `Security_Appliance_MR: ["Security_Appliance_MR"]` pulls
  the appliance back out into its own family-of-one).
- The security appliances are ordinary products whose sheet "family" is their own
  name (`Security_Appliance_CT` / `_MR`); map them as a family-of-one so their
  single rule resolves.
- `classification_dedup.py` prints the sheet's family strings that are **not yet
  mapped** in `product_families.json` (a live checklist). Interim CT mapping: the
  Somatom57 products -> `Somaris 5`, the SomatomX products -> `Somaris X`
  (`Somaris 7` stays dormant until a full list arrives); all MR products ->
  `Numaris 4/X` (bar the appliance). Manual cleanup of the remaining dormant
  families happens once in prod.
- **`load.py --stage classification`** re-applies the artifact by name
  (per-modality wipe-and-reload), resolving product names to current UUIDs and
  printing an UNMATCHED report for names not in the tree. It runs automatically
  on every `--stage all` / `--stage reference` reload, so a reload never loses
  classification. Unmatched names stay in the artifact for a later re-import.
- **`classification_export.py`** dumps the current DB back to `classification.json`
  -- run it after editing in the UI, then commit the file.

### CIM / Helpdesk files (second source)

`Data_Classification_CIM_fleetshell.xlsx` is a single-sheet source whose rules are
platform-generic (`Product = 'all_products'`) and identical across the modalities
it lists (AX, CT, MR, NM, PACS, XP). `classification_dedup.py --cim` folds it in
as ONE flat set named **"Helpdesk/CIM Files"** (100 rules), assigned
**modality-wide** in each of those modalities (so it fans out to every product,
including ones absent from the per-product sheet). Its column order differs and a
few headers were misspelled in the source; columns are matched by canonical
header name, so the file must use the canonical class labels.

The committed artifact (`classification.json`) is the durable source of truth;
the raw xlsx stays gitignored. On a full reload, `infrastructure/reload.sh` runs
`migrate_data_classification.sql` (step 0) then `load.py --stage all`, which
re-applies `--stage families` and `--stage classification` automatically.

## 8. UI controls (portal-dev)

The classification tab uses a shared compact toggle: the `--check-on` token in
`app.css` (a muted blend of the accent) drives a global `input[type=checkbox]`
style (15px filled-square, replacing the browser default) plus the assignment
matrix `.cell` buttons. The Rule Sets list scrolls internally (bounded flex
column); the assignment matrix has sticky header row + row-header column, with
the top-left corner at `z-index: 3` so it stays above both when scrolling.
