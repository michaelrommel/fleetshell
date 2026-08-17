#!/usr/bin/env bash
set -euo pipefail
#
# make_proxy_service.sh
#
# Stand up the `fleetshell-proxy` ECS/Fargate service: a horizontally-scaled
# Squid forward proxy (fixed port 8080) that authorizes device HTTP/HTTPS
# destinations via the `squid-infoproxy` external_acl helper against the Info
# Proxy allow-lists in Valkey.
#
# WHERE THIS SITS IN THE PIPELINE
# -------------------------------
# Device HTTP/HTTPS egress rides the IPSec tunnel (fleetsuite: LVS -> VPN nodes
# -> return gateways). ipsecnode SNATs the device to its GLOBAL identity IP
# (198.51.100.0/24 in the RFC-5737 test range) and the global service routing
# table splits destination port 8080 out of the tunnel into the BACKEND subnets.
# Today that split points at a single test backend (172.16.53.6). This script
# replaces that target with an INTERNAL NLB in front of the proxy task fleet.
#
#   device --tunnel--> ipsecnode (SNAT -> 198.51.100.x) --8080 split-->
#       NLB (client-IP preserved) --> Squid task --> squid-infoproxy --> Valkey
#                                          |
#                                          +--> permitted destination on the internet/intranet
#
# CRITICAL: the NLB target group MUST preserve the client IP so Squid's %SRC is
# the device global-identity IP (198.51.100.x). The helper keys Valkey on that
# IP: `infoproxy:<proxy_type>:<source_ip>`. Client-IP preservation also means
# the TASK security group is evaluated against the DEVICE IP (not the NLB), so
# ingress must allow 198.51.100.0/24 (data) + the backend subnet CIDRs (NLB
# health checks).
#
# HOW TO USE (mirrors the other infrastructure/*.sh scripts): run each STEP,
# paste the command output into the RESULT block beneath it, fill in the
# variables the next STEP needs, and commit.
#
# DISCOVERED / REUSED FACTS (describe-only, from the live account)
# ----------------------------------------------------------------
#   account            295934382486
#   region             eu-west-2
#   vpc                vpc-0595e17ce290fb050
#   ECS cluster        aeroftp-cluster
#   ECR registry       295934382486.dkr.ecr.eu-west-2.amazonaws.com
#   backend subnets    subnet-01a513292ea15ae83  FleetShell-IPSec-Backend-a  172.16.53.0/24  eu-west-2a
#                      subnet-08213d03f2940855c  FleetShell-IPSec-Backend-b  172.16.54.0/24  eu-west-2b
#                      (both on rtb-0a446e715fc3ec757 -> default route to Return GW master)
#   device global CIDR 198.51.100.0/24   (ipsecnode SNAT target; = Squid %SRC)
#   ECR/SSM endpoints  sg-0438c989d6fe0f276  (443 from 172.16.53.0/24 + 172.16.54.0/24
#                      ALREADY -- proxy runs in the backend subnets, so image
#                      pull via the private ECR endpoints works out of the box)
#   Valkey/MemoryDB SG sg-0709bc00b444b3a9a  (holds the 6379 self rule)
#   Valkey endpoint    rediss://clustercfg.dev-valkey-aeroftp.ak121m.memorydb.eu-west-2.amazonaws.com:6379
#   exec role          arn:aws:iam::295934382486:role/ecsTaskExecutionRole
#   task role          arn:aws:iam::295934382486:role/ecsTaskExecutionRoleWithSSM

export AWS_PAGER=""
REGION="eu-west-2"
ACCOUNT="295934382486"
VPC_ID="vpc-0595e17ce290fb050"
CLUSTER="aeroftp-cluster"
ECR_REGISTRY="295934382486.dkr.ecr.eu-west-2.amazonaws.com"
ECR_REPO="fleetshell/fleetshell-proxy"

SUBNET_BACKEND_A="subnet-01a513292ea15ae83"   # 172.16.53.0/24 eu-west-2a
SUBNET_BACKEND_B="subnet-08213d03f2940855c"   # 172.16.54.0/24 eu-west-2b
BACKEND_CIDR_A="172.16.53.0/24"
BACKEND_CIDR_B="172.16.54.0/24"
DEVICE_GLOBAL_CIDR="198.51.100.0/24"          # ipsecnode SNAT target == Squid %SRC

VALKEY_SG="sg-0709bc00b444b3a9a"              # MemoryDB SG (6379 self rule lives here)

# Filled in progressively by the STEPs below:
PROXY_SG=""            # STEP 2 -- fleetshell-proxy task security group
TG_ARN=""             # STEP 3 -- target group
NLB_ARN=""            # STEP 4 -- network load balancer
NLB_DNS=""            # STEP 4 -- NLB DNS name (used to repoint the 8080 split)
LISTENER_ARN=""       # STEP 5 -- NLB :8080 listener
TASKDEF_ARN=""        # STEP 7 -- registered task definition

# strip stray whitespace from any pasted ARNs/IDs.
for v in PROXY_SG TG_ARN NLB_ARN NLB_DNS LISTENER_ARN TASKDEF_ARN; do
  printf -v "$v" '%s' "$(echo -n "${!v}" | tr -d '[:space:]')"
done


# ===========================================================================
# STEP 0 -- ECR repository + CloudWatch log group (run once)
# ===========================================================================
# The image is built + pushed by scripts/build-proxy.sh (create separately,
# mirroring scripts/build_portal.sh). Log group is also auto-created by the
# task def (awslogs-create-group=true); creating it here lets you set retention.

# aws ecr create-repository \
#   --repository-name "${ECR_REPO}" \
#   --image-scanning-configuration scanOnPush=true \
#   --region "${REGION}" \
#   --query 'repository.repositoryUri' --output text

# aws logs create-log-group --log-group-name /ecs/fleetshell-proxy --region "${REGION}"
# aws logs put-retention-policy --log-group-name /ecs/fleetshell-proxy \
#   --retention-in-days 30 --region "${REGION}"

# ---- RESULT ----------------------------------------------------------------
#


# ===========================================================================
# STEP 1 -- Build + push the image
# ===========================================================================
# From the workspace root (build context = repo root so the Cargo workspace is
# visible). Mirror scripts/build_portal.sh; inline here for reference:
#
#   aws ecr get-login-password --region "${REGION}" \
#     | docker login --username AWS --password-stdin "${ECR_REGISTRY}"
#   docker build -f fleetshell-proxy/Dockerfile \
#     -t "${ECR_REGISTRY}/${ECR_REPO}:latest" .
#   docker push "${ECR_REGISTRY}/${ECR_REPO}:latest"

# ---- RESULT ----------------------------------------------------------------
#


# ===========================================================================
# STEP 2 -- Security group for the proxy task
# ===========================================================================
# Because the NLB target group preserves the client IP, the TASK SG is evaluated
# against the DEVICE global IP (198.51.100.0/24) for data-plane traffic, and
# against the NLB node IPs (backend subnet CIDRs) for health checks. Egress is
# left at the default allow-all (needs 443 to ECR endpoints, 6379 to Valkey, and
# 80/443 out to the permitted internet/intranet destinations).

# echo "# Create the proxy task SG"
# aws ec2 create-security-group \
#   --group-name fleetshell-proxy-task \
#   --description "fleetshell-proxy Squid task: 8080 from device global IP + NLB health checks" \
#   --vpc-id "${VPC_ID}" \
#   --tag-specifications 'ResourceType=security-group,Tags=[{Key=Name,Value=fleetshell-proxy-task}]' \
#   --region "${REGION}" --query 'GroupId' --output text

# ---- RESULT (paste GroupId, set PROXY_SG above) ----------------------------
# PROXY_SG=sg-XXXXXXXXXXXXXXXXX

# --- 2a. Ingress 8080: device data-plane (client-IP preserved) --------------
# aws ec2 authorize-security-group-ingress \
#   --group-id "${PROXY_SG}" --protocol tcp --port 8080 \
#   --cidr "${DEVICE_GLOBAL_CIDR}" --region "${REGION}"

# --- 2b. Ingress 8080: NLB health checks from each backend subnet -----------
# aws ec2 authorize-security-group-ingress \
#   --group-id "${PROXY_SG}" --protocol tcp --port 8080 \
#   --cidr "${BACKEND_CIDR_A}" --region "${REGION}"
# aws ec2 authorize-security-group-ingress \
#   --group-id "${PROXY_SG}" --protocol tcp --port 8080 \
#   --cidr "${BACKEND_CIDR_B}" --region "${REGION}"

# --- 2c. Allow the proxy SG to reach Valkey/MemoryDB on 6379 ----------------
# The helper connects to MemoryDB (rediss) from every task. Add the proxy SG as
# a source on the MemoryDB SG's 6379 rule (same pattern the portal used).
# aws ec2 authorize-security-group-ingress \
#   --group-id "${VALKEY_SG}" --protocol tcp --port 6379 \
#   --source-group "${PROXY_SG}" --region "${REGION}"

# ---- RESULT ----------------------------------------------------------------
#


# ===========================================================================
# STEP 3 -- Target group (IP type, TCP 8080, client-IP preservation ON)
# ===========================================================================
# target-type ip           -- Fargate awsvpc tasks register by ENI IP
# protocol TCP / port 8080 -- Squid http_port
# health check TCP:8080    -- Squid accepts the TCP connect once it is up
# preserve_client_ip=true  -- THE POINT: Squid %SRC must be the device IP

# aws elbv2 create-target-group \
#   --name fleetshell-proxy-tg \
#   --protocol TCP --port 8080 \
#   --vpc-id "${VPC_ID}" \
#   --target-type ip \
#   --health-check-protocol TCP --health-check-port 8080 \
#   --healthy-threshold-count 2 --unhealthy-threshold-count 2 \
#   --region "${REGION}" \
#   --query 'TargetGroups[0].TargetGroupArn' --output text

# ---- RESULT (paste ARN, set TG_ARN above) ----------------------------------
# TG_ARN=arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-proxy-tg/XXXXXXXXXXXX

# --- 3a. Enable client-IP preservation + deregistration tuning --------------
# aws elbv2 modify-target-group-attributes \
#   --target-group-arn "${TG_ARN}" \
#   --attributes \
#     Key=preserve_client_ip.enabled,Value=true \
#     Key=deregistration_delay.timeout_seconds,Value=30 \
#   --region "${REGION}"

# ---- RESULT ----------------------------------------------------------------
#


# ===========================================================================
# STEP 4 -- Internal Network Load Balancer (backend subnets)
# ===========================================================================
# scheme internal   -- reachable only from inside the VPC (tunnel-exit traffic)
# type network      -- L4, preserves the TCP source IP to the target group
# subnets = backend a/b (where the 8080 split delivers the SNAT'd device flow)
# NOTE: an NLB does not use a security group by default; access control is on
# the TARGET SG (STEP 2). (You may attach an SG to an NLB if desired.)

# aws elbv2 create-load-balancer \
#   --name fleetshell-proxy-nlb \
#   --type network --scheme internal \
#   --subnets "${SUBNET_BACKEND_A}" "${SUBNET_BACKEND_B}" \
#   --region "${REGION}" \
#   --query 'LoadBalancers[0].{arn:LoadBalancerArn,dns:DNSName}' --output json

# ---- RESULT (paste arn+dns, set NLB_ARN + NLB_DNS above) -------------------
# NLB_ARN=arn:aws:elasticloadbalancing:eu-west-2:295934382486:loadbalancer/net/fleetshell-proxy-nlb/XXXXXXXXXXXX
# NLB_DNS=fleetshell-proxy-nlb-XXXXXXXX.elb.eu-west-2.amazonaws.com


# ===========================================================================
# STEP 5 -- NLB listener TCP:8080 -> target group
# ===========================================================================
# aws elbv2 create-listener \
#   --load-balancer-arn "${NLB_ARN}" \
#   --protocol TCP --port 8080 \
#   --default-actions Type=forward,TargetGroupArn="${TG_ARN}" \
#   --region "${REGION}" \
#   --query 'Listeners[0].ListenerArn' --output text

# ---- RESULT (paste ARN, set LISTENER_ARN above) ----------------------------
# LISTENER_ARN=arn:aws:elasticloadbalancing:eu-west-2:295934382486:listener/net/fleetshell-proxy-nlb/XXXX/XXXX


# ===========================================================================
# STEP 6 -- Register the task definition
# ===========================================================================
# Edit infrastructure/deploy_proxy_taskdef.json first if needed (PROXY_TYPE,
# HELPER_CHILDREN, VALKEY_URL, cpu/mem). One line, no heredoc.

# aws ecs register-task-definition \
#   --cli-input-json file://deploy_proxy_taskdef.json \
#   --region "${REGION}" --query 'taskDefinition.taskDefinitionArn' --output text

# ---- RESULT (paste ARN, set TASKDEF_ARN above; e.g. .../fleetshell-proxy:1) -
# TASKDEF_ARN=arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-proxy:1


# ===========================================================================
# STEP 7 -- Create the ECS service (Fargate, backend subnets, behind the NLB)
# ===========================================================================
# assignPublicIp DISABLED -- tasks live in the PRIVATE backend subnets; image
# pull + Valkey go through the VPC endpoints / private routes.
# desiredCount 2 -- one warm task per AZ; autoscaling (STEP 8) grows from here.
# health-check-grace-period -- give Squid time to come up before the NLB culls.

# aws ecs create-service \
#   --cluster "${CLUSTER}" \
#   --service-name fleetshell-proxy-service \
#   --task-definition fleetshell-proxy \
#   --desired-count 2 \
#   --launch-type FARGATE \
#   --enable-execute-command \
#   --health-check-grace-period-seconds 30 \
#   --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_BACKEND_A},${SUBNET_BACKEND_B}],securityGroups=[${PROXY_SG}],assignPublicIp=DISABLED}" \
#   --load-balancers "targetGroupArn=${TG_ARN},containerName=fleetshell-proxy,containerPort=8080" \
#   --region "${REGION}" \
#   --query 'service.{name:serviceName,status:status,desired:desiredCount,taskDef:taskDefinition}'

# ---- RESULT ----------------------------------------------------------------
#

# Wait for stability + verify health:
# aws ecs wait services-stable --cluster "${CLUSTER}" --services fleetshell-proxy-service --region "${REGION}"
# aws elbv2 describe-target-health --target-group-arn "${TG_ARN}" --region "${REGION}" \
#   --query 'TargetHealthDescriptions[].{ip:Target.Id,state:TargetHealth.State}'
# aws logs tail /ecs/fleetshell-proxy --since 10m --follow --region "${REGION}"


# ===========================================================================
# STEP 8 -- Auto scaling (scale out on network saturation)
# ===========================================================================
# An NLB has no per-target request metric, so the throughput signal is the LB
# ProcessedBytes. We scale the ECS service on a TARGET-TRACKING policy over a
# per-task-normalised bytes metric. (Simpler alternative: target-track ECS
# service average CPU -- Squid is CPU-bound under TLS CONNECT volume; see 8-alt.)

# --- 8a. Register the ECS service as a scalable target ----------------------
# aws application-autoscaling register-scalable-target \
#   --service-namespace ecs \
#   --resource-id "service/${CLUSTER}/fleetshell-proxy-service" \
#   --scalable-dimension ecs:service:DesiredCount \
#   --min-capacity 2 --max-capacity 20 \
#   --region "${REGION}"

# --- 8b. Target-tracking on NLB ProcessedBytes per task ---------------------
# Requires a scaling-config JSON referencing the NLB + a target bytes/task
# threshold. Fill LoadBalancer + target value, then apply. Example target:
# 50 MB/s sustained per task (tune against observed Squid throughput).
#
#   cat > /tmp/proxy-scale-bytes.json <<'JSON'
#   {
#     "TargetValue": 52428800,
#     "CustomizedMetricSpecification": {
#       "MetricName": "ProcessedBytes",
#       "Namespace": "AWS/NetworkELB",
#       "Statistic": "Average",
#       "Unit": "Bytes",
#       "Dimensions": [
#         { "Name": "LoadBalancer", "Value": "net/fleetshell-proxy-nlb/XXXXXXXXXXXX" }
#       ]
#     },
#     "ScaleInCooldown": 300,
#     "ScaleOutCooldown": 60
#   }
#   JSON
#
# aws application-autoscaling put-scaling-policy \
#   --service-namespace ecs \
#   --resource-id "service/${CLUSTER}/fleetshell-proxy-service" \
#   --scalable-dimension ecs:service:DesiredCount \
#   --policy-name fleetshell-proxy-bytes-tt \
#   --policy-type TargetTrackingScaling \
#   --target-tracking-scaling-policy-configuration file:///tmp/proxy-scale-bytes.json \
#   --region "${REGION}"

# --- 8-alt. Simpler: target-track ECS service average CPU at 60% ------------
# aws application-autoscaling put-scaling-policy \
#   --service-namespace ecs \
#   --resource-id "service/${CLUSTER}/fleetshell-proxy-service" \
#   --scalable-dimension ecs:service:DesiredCount \
#   --policy-name fleetshell-proxy-cpu-tt \
#   --policy-type TargetTrackingScaling \
#   --target-tracking-scaling-policy-configuration \
#     'PredefinedMetricSpecification={PredefinedMetricType=ECSServiceAverageCPUUtilization},TargetValue=60,ScaleInCooldown=300,ScaleOutCooldown=60' \
#   --region "${REGION}"

# ---- RESULT ----------------------------------------------------------------
#


# ===========================================================================
# STEP 9 -- Repoint the tunnel 8080 split at the NLB (fleetsuite / ipsecnode)
# ===========================================================================
# This lives in the SISTER project (../fleetsuite). The ipsecnode global service
# routing table currently splits destination port 8080 to the single test
# backend 172.16.53.6. Change that target to the proxy NLB so tunnel-exit HTTP/
# HTTPS lands on the Squid fleet:
#
#   * Resolve the NLB's private IPs (one per backend subnet):
#       aws ec2 describe-network-interfaces \
#         --filters "Name=description,Values=ELB net/fleetshell-proxy-nlb/*" \
#         --query 'NetworkInterfaces[].PrivateIpAddress' --output text --region "${REGION}"
#   * Update the ipsecnode svcroute (ipsecnode.toml port-split for 8080) to
#     target those IPs (or the NLB DNS if the split resolver supports names).
#   * See fleetsuite AGENTS.md "Global service routing table (ipsecnode_svcroute)".
#
# ---- RESULT ----------------------------------------------------------------
#


# ===========================================================================
# ROLLBACK
# ===========================================================================
# Point the 8080 split back at the old test backend (STEP 9 in reverse), then:
#   aws ecs update-service --cluster "${CLUSTER}" --service fleetshell-proxy-service \
#     --desired-count 0 --region "${REGION}"
#   aws ecs delete-service --cluster "${CLUSTER}" --service fleetshell-proxy-service \
#     --force --region "${REGION}"
#   aws elbv2 delete-listener     --listener-arn "${LISTENER_ARN}" --region "${REGION}"
#   aws elbv2 delete-load-balancer --load-balancer-arn "${NLB_ARN}" --region "${REGION}"
#   aws elbv2 delete-target-group --target-group-arn "${TG_ARN}" --region "${REGION}"
