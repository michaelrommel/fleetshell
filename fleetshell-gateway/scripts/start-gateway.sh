#!/usr/bin/env bash

set -euo pipefail

export RUST_LOG=info
export JWT_SECRET="change-me-in-production"
#export GATEWAY_TLS="true"
export GATEWAY_HEALTH_ADDR="0.0.0.0:8888"
export GUACD_DRIVE_PATH="/tmp/guac/drives"
export GUACD_RECORDING_PATH="/tmp/guac/recordings"
./target/release/fleetshell-gateway

