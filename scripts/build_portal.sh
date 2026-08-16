#!/usr/bin/env bash
set -euo pipefail
#
# Build + push the FleetShell MDM portal image to ECR, replacing the running
# container. Build context is the repo root; the Dockerfile lives at
# fleetshell-portal/Dockerfile and ships the custom server.js (WebSocket) entry.
#
# --platform linux/amd64 so the image runs on ECS Fargate regardless of the
# builder's architecture. BASE_PATH defaults to '' (site root); override only
# when deploying under a sub-path.

REGISTRY="295934382486.dkr.ecr.eu-west-2.amazonaws.com"
IMAGE="fleetshell/fleetshell-portal"
BASE_PATH="${BASE_PATH:-}"

aws ecr get-login-password --region eu-west-2 \
  | docker login --username AWS --password-stdin "${REGISTRY}"

docker buildx build \
  --platform linux/amd64 \
  --build-arg "BASE_PATH=${BASE_PATH}" \
  -f fleetshell-portal/Dockerfile \
  -t "${IMAGE}:latest" \
  --load \
  .

docker tag "${IMAGE}:latest" "${REGISTRY}/${IMAGE}:latest"
docker push "${REGISTRY}/${IMAGE}:latest"
