#!/usr/bin/env bash
# mint_jwt.sh — create a signed JWT for local gateway testing without needing
# the portal.  Signs with JWT_SECRET directly using openssl + base64.
#
# Usage:
#   ./scripts/mint_jwt.sh <target> <ports> [gateway]
#
# Environment variables:
#   JWT_SECRET   HMAC-SHA256 signing secret.
#                Default: "change-me-in-production" (the gateway's dev default —
#                matches a local gateway started without JWT_SECRET set).
#   JWT_TTL      Token lifetime in seconds.  Default: 86400 (24 h).
#
# Examples:
#   # Local gateway with default secret:
#   ./scripts/mint_jwt.sh 192.168.13.187 5900 127.0.0.1:8443
#
#   # Local gateway started with a specific secret:
#   JWT_SECRET="my-local-secret" ./scripts/mint_jwt.sh 192.168.13.187 5900 127.0.0.1:8443
#
#   # No gateway binding (token accepted by any gateway):
#   ./scripts/mint_jwt.sh 192.168.13.187 "443,5900"
#
# Then test with test-guac:
#   PROTOCOL=vnc \
#   GATEWAY_TLS=true \
#   GATEWAY_NAME="127.0.0.1:8443" \
#   TOKEN="$(./scripts/mint_jwt.sh 192.168.13.187 5900 127.0.0.1:8443)" \
#   ./target/release/test-guac --gateway 127.0.0.1:8443 192.168.13.187 5900 user pass

set -euo pipefail

TARGET="${1:?Usage: $0 <target> <ports> [gateway]}"
PORTS="${2:?Usage: $0 <target> <ports> [gateway]}"
GATEWAY="${3:-}"
SECRET="${JWT_SECRET:-change-me-in-production}"
TTL="${JWT_TTL:-86400}"

now=$(date +%s)
exp=$((now + TTL))

# base64url encode: standard base64 → strip newlines → swap +/ to -_ → strip padding
b64url() {
    base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='
}

header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)

if [[ -n "$GATEWAY" ]]; then
    payload_json=$(printf \
        '{"sub":"local-dev","iat":%d,"exp":%d,"target":"%s","ports":"%s","gw":"%s"}' \
        "$now" "$exp" "$TARGET" "$PORTS" "$GATEWAY")
else
    payload_json=$(printf \
        '{"sub":"local-dev","iat":%d,"exp":%d,"target":"%s","ports":"%s"}' \
        "$now" "$exp" "$TARGET" "$PORTS")
fi

payload=$(printf '%s' "$payload_json" | b64url)

sig=$(printf '%s.%s' "$header" "$payload" \
    | openssl dgst -sha256 -hmac "$SECRET" -binary \
    | b64url)

echo "${header}.${payload}.${sig}"
