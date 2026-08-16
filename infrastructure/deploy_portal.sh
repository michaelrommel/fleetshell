#!/usr/bin/env bash
set -euo pipefail
#
# deploy_portal.sh
#
# Migrate the ECS service `fleetshell-portal-service-v6kb01vb` (cluster
# aeroftp-cluster) from the OLD portal task definition (fleetshell-portal:6) to
# the NEW Aurora-backed MDM portal.
#
# The image (295934382486.dkr.ecr.eu-west-2.amazonaws.com/fleetshell/fleetshell-portal:latest)
# is swapped by scripts/build_portal.sh; this script swaps the TASK DEFINITION
# (env + secrets) and forces a new deployment. The ALB / target group / network
# are unchanged.
#
# HOW TO USE (mirrors the other infrastructure/*.sh scripts): run each STEP,
# paste the command output into the RESULT block beneath it, and commit.
#
# Discovered from the live account (describe-only), 2026:
#   cluster            aeroftp-cluster
#   service            fleetshell-portal-service-v6kb01vb
#   family             fleetshell-portal   (current active revision :6)
#   container          fleetshell-portal   port 3000  -> target group fleetshell-portal-tg
#   execution role     ecsTaskExecutionRole            (has SecretsManagerReadWrite)
#   task role          ecsTaskExecutionRoleWithSSM
#   cpu/mem            512 / 1024   FARGATE / X86_64 / awsvpc
#   Global Aurora      RDS Proxy  fleetshell-global-proxy.proxy-cpgmocimewi5.eu-west-2.rds.amazonaws.com  db=fleetshell
#   Local  Aurora      cluster    fleetshell-local-euw2.cluster-cpgmocimewi5.eu-west-2.rds.amazonaws.com   db=fleetshell_local
#   Global creds       secret fleetshell/global/master        (JSON keys username/password)
#   Local  creds       secret rds!cluster-4a19c703-...-I6Wbu0 (RDS-managed; JSON username/password)
#   Valkey             rediss://clustercfg.dev-valkey-aeroftp.ak121m.memorydb.eu-west-2.amazonaws.com:6379
#   JWT_SECRET         secret aerotrack/auth_secret   (MUST match the gateway)
#   CLIENT_CERT/KEY    secrets fleetshell/client-cert , fleetshell/client-key
#
# NOTE: the local RDS-managed secret + the global secret both use the AWS-managed
# aws/secretsmanager KMS key, so the execution role's SecretsManagerReadWrite is
# sufficient -- no extra kms:Decrypt policy is required.

export AWS_PAGER=""
REGION="eu-west-2"
CLUSTER="aeroftp-cluster"
SERVICE="fleetshell-portal-service-v6kb01vb"
FAMILY="fleetshell-portal"

# Fixed secret ARNs (from describe):
SEC_CLIENT_CERT="arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/client-cert-Uhh4oy"
SEC_CLIENT_KEY="arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/client-key-OvOAuj"
SEC_JWT="arn:aws:secretsmanager:eu-west-2:295934382486:secret:aerotrack/auth_secret-zTocUO"
SEC_GLOBAL="arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/global/master-x3Pexj"
SEC_LOCAL="arn:aws:secretsmanager:eu-west-2:295934382486:secret:rds!cluster-4a19c703-8dc1-4f23-8d36-326d9ca0f398-I6Wbu0"

# Filled in by STEP 0 (paste the returned ARN here, then run STEP 1+):
SEC_SESSION="arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/portal/session-secret-K8vmuH"

# ---------------------------------------------------------------------------
# STEP 0 -- Create the SESSION_SECRET (cookie signing key). Run once.
# ---------------------------------------------------------------------------
# aws secretsmanager create-secret \
#   --name fleetshell/portal/session-secret \
#   --description "FleetShell MDM portal cookie signing key" \
#   --secret-string "$(openssl rand -base64 32)" \
#   --region "${REGION}" \
#   --query ARN --output text

# ---- RESULT (paste the ARN, then set SEC_SESSION above) --------------------
# SEC_SESSION=arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/portal/session-secret-XXXXXX
# arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/portal/session-secret-K8vmuH


# ---------------------------------------------------------------------------
# STEP 1 -- Register the new task definition revision (env + secrets swapped).
# ---------------------------------------------------------------------------
# Requires SEC_SESSION to be set (STEP 0). Writes the container definition to a
# temp file and registers it as a new revision of the same family.

# register() {
#   [ -n "${SEC_SESSION}" ] || { echo "Set SEC_SESSION (STEP 0) first." >&2; exit 1; }
#   local tmp; tmp="$(mktemp)"
#   cat > "${tmp}" <<JSON
# {
#   "family": "${FAMILY}",
#   "networkMode": "awsvpc",
#   "requiresCompatibilities": ["FARGATE"],
#   "cpu": "512",
#   "memory": "1024",
#   "executionRoleArn": "arn:aws:iam::295934382486:role/ecsTaskExecutionRole",
#   "taskRoleArn": "arn:aws:iam::295934382486:role/ecsTaskExecutionRoleWithSSM",
#   "runtimePlatform": { "cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX" },
#   "containerDefinitions": [
#     {
#       "name": "fleetshell-portal",
#       "image": "295934382486.dkr.ecr.eu-west-2.amazonaws.com/fleetshell/fleetshell-portal:latest",
#       "essential": true,
#       "portMappings": [
#         { "containerPort": 3000, "hostPort": 3000, "protocol": "tcp", "name": "portal-3000-tcp" }
#       ],
#       "environment": [
#         { "name": "PORT",           "value": "3000" },
#         { "name": "HOST",           "value": "0.0.0.0" },
#         { "name": "NODE_ENV",       "value": "production" },
#         { "name": "NO_COLOR",       "value": "true" },
#         { "name": "BASE_PATH",      "value": "" },
#         { "name": "ORIGIN",         "value": "https://portal.fleetshell.com" },
#         { "name": "AWS_REGION",     "value": "eu-west-2" },
#         { "name": "PGSSL",          "value": "require" },
#         { "name": "GLOBAL_DB_HOST", "value": "fleetshell-global-proxy.proxy-cpgmocimewi5.eu-west-2.rds.amazonaws.com" },
#         { "name": "GLOBAL_DB_PORT", "value": "5432" },
#         { "name": "GLOBAL_DB_NAME", "value": "fleetshell" },
#         { "name": "LOCAL_DB_HOST",  "value": "fleetshell-local-euw2.cluster-cpgmocimewi5.eu-west-2.rds.amazonaws.com" },
#         { "name": "LOCAL_DB_PORT",  "value": "5432" },
#         { "name": "LOCAL_DB_NAME",  "value": "fleetshell_local" },
#         { "name": "VALKEY_URL",     "value": "rediss://clustercfg.dev-valkey-aeroftp.ak121m.memorydb.eu-west-2.amazonaws.com:6379" }
#       ],
#       "secrets": [
#         { "name": "CLIENT_CERT",        "valueFrom": "${SEC_CLIENT_CERT}" },
#         { "name": "CLIENT_KEY",         "valueFrom": "${SEC_CLIENT_KEY}" },
#         { "name": "JWT_SECRET",         "valueFrom": "${SEC_JWT}" },
#         { "name": "SESSION_SECRET",     "valueFrom": "${SEC_SESSION}" },
#         { "name": "GLOBAL_DB_USER",     "valueFrom": "${SEC_GLOBAL}:username::" },
#         { "name": "GLOBAL_DB_PASSWORD", "valueFrom": "${SEC_GLOBAL}:password::" },
#         { "name": "LOCAL_DB_USER",      "valueFrom": "${SEC_LOCAL}:username::" },
#         { "name": "LOCAL_DB_PASSWORD",  "valueFrom": "${SEC_LOCAL}:password::" }
#       ],
#       "logConfiguration": {
#         "logDriver": "awslogs",
#         "options": {
#           "awslogs-group": "/ecs/fleetshell-portal",
#           "awslogs-create-group": "true",
#           "awslogs-region": "eu-west-2",
#           "awslogs-stream-prefix": "ecs"
#         }
#       }
#     }
#   ]
# }
# JSON
#   aws ecs register-task-definition --cli-input-json "file://${tmp}" \
#     --region "${REGION}" --query 'taskDefinition.taskDefinitionArn' --output text
#   rm -f "${tmp}"
# }
# register

# ---- RESULT (paste the new task-definition ARN, e.g. .../fleetshell-portal:7) ----
# arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:8


# ---------------------------------------------------------------------------
# STEP 2 -- Point the service at the new revision + force a fresh deployment.
# ---------------------------------------------------------------------------
# Using the bare family makes ECS pick the latest ACTIVE revision (the one from
# STEP 1). --force-new-deployment also re-pulls :latest so a rebuilt image lands.
aws ecs update-service \
  --cluster "${CLUSTER}" --service "${SERVICE}" \
  --task-definition "${FAMILY}" \
  --force-new-deployment \
  --region "${REGION}" \
  --query 'service.{taskDef:taskDefinition,deployments:deployments[].{status:status,desired:desiredCount,running:runningCount,rollout:rolloutState}}'

# ---- RESULT ----------------------------------------------------------------

# {
#     "taskDef": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:7",
#     "deployments": [
#         {
#             "status": "PRIMARY",
#             "desired": 0,
#             "running": 0,
#             "rollout": "IN_PROGRESS"
#         }
#     ]
# }


# ---------------------------------------------------------------------------
# STEP 3 -- Wait for stability + verify (logs, health).
# ---------------------------------------------------------------------------
aws ecs wait services-stable --cluster "${CLUSTER}" --services "${SERVICE}" --region "${REGION}"
aws ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE}" --region "${REGION}" \
  --query 'services[0].{running:runningCount,desired:desiredCount,taskDef:taskDefinition,events:events[0:3].message}'
# Tail the app log (expects: "fleetshell-portal listening on 0.0.0.0:3000"):
aws logs tail /ecs/fleetshell-portal --since 10m --follow --region "${REGION}"

# ---- RESULT ----------------------------------------------------------------
#


# ---------------------------------------------------------------------------
# ROLLBACK (if needed): point back at the known-good old revision.
# ---------------------------------------------------------------------------
# aws ecs update-service --cluster "${CLUSTER}" --service "${SERVICE}" \
#   --task-definition fleetshell-portal:6 --force-new-deployment --region "${REGION}"
