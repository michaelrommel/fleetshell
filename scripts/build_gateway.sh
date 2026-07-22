#!/usr/bin/env bash

aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 295934382486.dkr.ecr.eu-west-2.amazonaws.com

docker buildx build -f fleetshell-gateway/Dockerfile -t fleetshell/fleetshell-gateway:latest .
docker tag fleetshell/fleetshell-gateway:latest 295934382486.dkr.ecr.eu-west-2.amazonaws.com/fleetshell/fleetshell-gateway:latest
docker push 295934382486.dkr.ecr.eu-west-2.amazonaws.com/fleetshell/fleetshell-gateway:latest
