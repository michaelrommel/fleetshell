#!/usr/bin/env bash
set -euo pipefail

CARGO_TOML="fleetshell-client/src-tauri/Cargo.toml"
TAURI_CONF="fleetshell-client/src-tauri/tauri.conf.json"
DOCKERFILE="fleetshell-portal/Dockerfile"

# Read authoritative version from Cargo.toml
CURRENT_VERSION=$(
    grep '^version *= *"' "$CARGO_TOML" \
    | sed -E 's/version *= *"([^"]+)"/\1/'
)

echo "Current version: $CURRENT_VERSION"

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

NEW_VERSION="${MAJOR}.$((MINOR + 1)).0"

echo "New version: $NEW_VERSION"

FILES=(
    "$CARGO_TOML"
    "$TAURI_CONF"
    "$DOCKERFILE"
)

for FILE in "${FILES[@]}"; do
    sed -i "s/${CURRENT_VERSION}/${NEW_VERSION}/g" "$FILE"
    echo "Updated $FILE"
done

echo
echo "Version bumped:"
echo "  $CURRENT_VERSION -> $NEW_VERSION"
