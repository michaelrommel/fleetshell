#!/usr/bin/env bash
#
# apply_additive.sh -- apply ONE additive, idempotent SQL migration to the live
# GLOBAL Aurora, WITHOUT the destructive full reload (no TRUNCATE, no catalog
# privilege delete). Safe to run against a database a running portal shares.
#
# Use this for additive changes only (new table/column/type/function,
# CREATE OR REPLACE, ADD COLUMN ... NULL). For destructive/renaming migrations,
# deploy a new portal container together with the change instead.
#
# Usage:
#   GLOBAL_WRITER_URL="postgresql://fsadmin:...@localhost:5432/fleetshell?sslmode=require" \
#     ./infrastructure/apply_additive.sh sql/migrate_services_authz.sql
#
set -euo pipefail
cd "$(dirname "$0")"

FILE="${1:-}"
if [[ -z "$FILE" ]]; then
	echo "usage: GLOBAL_WRITER_URL=... $0 <sql-file>   (relative to infrastructure/)" >&2
	exit 2
fi
if [[ ! -f "$FILE" ]]; then
	echo "error: $FILE not found (run from repo root; path is relative to infrastructure/)" >&2
	exit 2
fi
if [[ -z "${GLOBAL_WRITER_URL:-}" ]]; then
	echo "error: GLOBAL_WRITER_URL is not set" >&2
	exit 2
fi

# Guard: refuse anything that mutates existing data/shape. This script is for
# purely additive migrations, so an old portal sharing the DB stays intact.
if grep -iEq '\b(truncate|drop\s+table|drop\s+column|alter\s+column|rename)\b' "$FILE"; then
	echo "REFUSING: $FILE contains a destructive statement (TRUNCATE/DROP/ALTER COLUMN/RENAME)." >&2
	echo "Deploy a new portal container together with that change instead." >&2
	exit 1
fi

echo "Applying additive migration: $FILE"
echo "  -> ${GLOBAL_WRITER_URL%%@*}@$(echo "$GLOBAL_WRITER_URL" | sed 's/.*@//')"
read -r -p "Proceed? [y/N] " ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted."; exit 1; }

psql "$GLOBAL_WRITER_URL" -v ON_ERROR_STOP=1 -f "$FILE"
echo "done."
