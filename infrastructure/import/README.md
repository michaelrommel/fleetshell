# Bulk import

See `docs/data_import.md` for the full plan. Quick reference:

```
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 1. Land the CSV/JSON exports here (gitignored, never committed):
mkdir -p staging && cp /path/to/exports/*.csv staging/

# 2. Transform + load (load.py written once column mapping is fixed):
python load.py            # anonymizes via anonymize.py, COPYs into dev clusters

# 3. Validate:
psql "$GLOBAL_URL" -f benchmark.sql

# 4. Destroy the run maps (irreversible):
rm -f *.map.json
```

`anonymize.py` holds the reusable core (IdMap / LabelMap / fakers). `load.py`
and `benchmark.sql` are added after we see a sample export and fix the column
mapping.
