# Data Transfer Matrix (DTM)

Per FROM-country rules that decide, for a destination country and a data class,
whether a transfer is **permitted** or **denied**. The matrix is anchored in the
**FROM** (data-origin) country: a Country Manager maintains their own country's
outbound rules. Lives in `Countries -> Data Transfer Matrix`.

## Model

- **FROM** country = data origin (a device's `country_iso`).
- **TO** country = destination. Resolved **per service** at check time:
  - remote connections: the accessing user's country (`app_user.country`);
  - file transfer (aeroftp): its own destination rule (defined when aeroftp is wired).
- **data class** = what is being transferred. Catalog is `data_class` (shared with
  the classification feature), tagged by `kind`:
  - `file` - device->cloud data (aeroftp consults these);
  - `connection` - Remote Desktop Sharing, Reactive Sessions (remote services);
  - `distribution` - software/virus/option pushes to the device.
- **variant** = a named rule profile (`dtm_variant`): `STD` (Standard, default),
  `STR` (Strict), extensible. Chosen at runtime by the device's **customer**
  (`customer.dtm_variant`); a device with no customer uses the country's Standard
  matrix if defined, else defaults to permitted.

### Storage: denial-list, default = permit

Only **denied** `(from, to, variant, class)` tuples are stored (`dtm_deny`).
Absence of a row => permitted. No matrix for a FROM country => all permitted.
`dtm_matrix` is the header (one row per defined FROM x variant).

> `STD` collision: `data_class.code = 'STD'` ("Smart Technical Data") vs
> `dtm_variant.code = 'STD'` ("Standard"). Separate namespaces; never ambiguous
> in a Valkey key (the variant is the last key segment; classes are the VALUE).

## Valkey (runtime lookup, hash-tagged)

```
SET dtm:{<FROM>}:<TO>:<VARIANT>   members = denied data-class codes
```

The `{<FROM>}` hash tag co-locates a whole origin country in **one** MemoryDB
cluster slot, so the export swaps a country ATOMICALLY (one MULTI/EXEC:
multi-key `UNLINK` old + `SADD` new) and multi-key ops within a country are legal.
aerosuite reads single-key:

```
SISMEMBER dtm:{<from>}:<to>:<variant> <class>   -> member => DENY
```

MemoryDB is always cluster-mode; there is no setting to relax cross-slot checks,
so cross-country multi-key commands are impossible by design - the hash tag is
what makes per-country multi-key work. Bulk throughput otherwise comes from
pipelining (single-key commands issued without an await between them).

## Files

- `infrastructure/sql/migrate_dtm.sql` (GLOBAL) - `data_class` extended
  (`kind`, `mrs_id` + 12 DTM classes), `dtm_variant`, `dtm_matrix`, `dtm_deny`,
  `customer.dtm_variant`.
- `infrastructure/sql/migrate_user_country.sql` (LOCAL) - `app_user.country`.
- `infrastructure/import/dtm_dedup.py` - 10 SRS workbooks -> committed
  `dtm.json` (name->code via MRS id; only denials).
- `load.py` `stage_dtm` - re-applies `dtm.json` (reload-survivable); `stage_users`
  imports `app_user.country` from `RDUSER.COUNTRYID`.
- `fleetshell-portal/src/lib/server/dtm.ts` - loaders, `saveMatrix`,
  `syncFromCountryToValkey` (atomic per-country), and the `dtmKey` builder.
- `fleetshell-portal/scripts/spool-dtm.mjs` - standalone bulk/reconcile
  export (atomic per country; drops stale/legacy keys).
- `Countries -> Data Transfer Matrix` editor - grid (destination rows x class
  columns grouped by kind), exceptions-first view, row/column bulk-set,
  Save + Export to Valkey. Interim admin-gated; later `authz_can('region','edit')`
  scoped to the FROM country.

## Deployed data

10 workbooks: FROM in {FI, DE, IT, JP, NO, US}; variants Standard/Strict
(JP, US Standard only). ~252 destinations x 16 classes (4 retired columns --
RD3/UPD3/PSHI/GFT -- are ignored by the importer); deployed cells are only
permit/deny (unknown/contract defined but unused).
