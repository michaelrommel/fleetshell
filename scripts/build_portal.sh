#!/usr/bin/env bash

aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 295934382486.dkr.ecr.eu-west-2.amazonaws.com

docker buildx build -f fleetshell-portal/Dockerfile -t fleetshell/fleetshell-portal:latest .
docker tag fleetshell/fleetshell-portal:latest 295934382486.dkr.ecr.eu-west-2.amazonaws.com/fleetshell/fleetshell-portal:latest
docker push 295934382486.dkr.ecr.eu-west-2.amazonaws.com/fleetshell/fleetshell-portal:latest
