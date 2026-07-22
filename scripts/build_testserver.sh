#!/usr/bin/env bash
# build.sh — build the Docker image for the test-server
set -euo pipefail

aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 295934382486.dkr.ecr.eu-west-2.amazonaws.com

docker buildx build -f test-server/Dockerfile -t fleetshell/test-server:latest .
docker tag fleetshell/test-server:latest 295934382486.dkr.ecr.eu-west-2.amazonaws.com/fleetshell/test-server:latest
docker push 295934382486.dkr.ecr.eu-west-2.amazonaws.com/fleetshell/test-server:latest

