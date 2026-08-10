#!/usr/bin/env bash
set -euo pipefail
#
# make_gateway_migrate.sh
#
# Migrate the fleetshell-gateway ECS/Fargate service out of the public subnet
# (FleetShell-backend-public, 172.16.34.0/26, default route -> IGW) and into the
# IPSec backend subnets (FleetShell-IPSec-Backend-a/b, 172.16.53/54.0/24,
# default route -> Return GW).  This is what routes gateway->device traffic
# through the VPN concentrators instead of the public internet.
#
# WHY THE NLB KEEPS WORKING WITHOUT SG CHANGES
# --------------------------------------------
#   * NLB net/fleetshell-gateway-nlb has security group sg-0a29113f0d29e4adf.
#   * Gateway SG sg-065f9193da9f46436 already allows 8443 from that NLB SG
#     (SG references are location-independent -> valid in any subnet).
#   * Health check (HTTP :8080) is allowed from the NLB subnet CIDRs
#     172.16.0.0/20 + 172.16.16.0/20 -> still valid.
#   * ECS re-registers the new task IP in the target group automatically.
# So the gateway task SG is UNCHANGED and no target-group edits are needed.
#
# WHAT MUST CHANGE
# ----------------
#   1. Let the backend subnets reach the Secrets Manager + CloudWatch Logs
#      interface endpoints (JWT_SECRET secret + awslogs driver).  These live in
#      the portal subnets behind sg-096b2f00f8de6901a which today allows only
#      portal CIDRs.  Private DNS is VPC-wide and a service may have only ONE
#      private-DNS endpoint per VPC, so we REUSE them and just open 443 to the
#      backend CIDRs.
#   2. Move the service to the backend subnets, keep the gateway SG, and set
#      assignPublicIp=DISABLED (no IGW in the backend subnets).
#
# ALREADY IN PLACE (no action):
#   * ECR api/dkr endpoints allow backend CIDRs (sg-0438c989d6fe0f276).
#   * S3 gateway endpoint is on the backend RTB (image layers + dev-s3-fleetshell).
#   * All startup traffic rides the VPC-local route -> does NOT need the Return
#     GW to be up; only device traffic does.

REGION="eu-west-2"

# Backend (IPSec device) subnets -- default route 0.0.0.0/0 -> Return GW:
SUBNET_BACKEND_A="subnet-01a513292ea15ae83"   # FleetShell-IPSec-Backend-a (172.16.53.0/24, eu-west-2a)
SUBNET_BACKEND_B="subnet-08213d03f2940855c"   # FleetShell-IPSec-Backend-b (172.16.54.0/24, eu-west-2b)
CIDR_BACKEND_A="172.16.53.0/24"
CIDR_BACKEND_B="172.16.54.0/24"

GATEWAY_SG="sg-065f9193da9f46436"             # fleetshell-gateway task SG (unchanged, reused)
PORTAL_EP_SG="sg-096b2f00f8de6901a"           # FleetShell-portal-sg-endpoints (SM + Logs endpoints)

# ---------------------------------------------------------------------------
# STEP 1 -- Allow the backend subnets to reach the SM + Logs interface endpoints
# ---------------------------------------------------------------------------

# echo "# Allow HTTPS from backend subnets to the SM + Logs endpoints"
# aws ec2 authorize-security-group-ingress --group-id "${PORTAL_EP_SG}" \
#   --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":443,\"ToPort\":443,\"IpRanges\":[{\"CidrIp\":\"${CIDR_BACKEND_A}\",\"Description\":\"Backend-a (gateway)\"},{\"CidrIp\":\"${CIDR_BACKEND_B}\",\"Description\":\"Backend-b (gateway)\"}]}]" \
#   --region "${REGION}"

# RESULT
# # Allow HTTPS from backend subnets to the SM + Logs endpoints
# {
#     "Return": true,
#     "SecurityGroupRules": [
#         {
#             "SecurityGroupRuleId": "sgr-01362d7bd32a7573c",
#             "GroupId": "sg-096b2f00f8de6901a",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 443,
#             "ToPort": 443,
#             "CidrIpv4": "172.16.53.0/24",
#             "Description": "Backend-a (gateway)"
#         },
#         {
#             "SecurityGroupRuleId": "sgr-0e9df2917c57e5a5f",
#             "GroupId": "sg-096b2f00f8de6901a",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 443,
#             "ToPort": 443,
#             "CidrIpv4": "172.16.54.0/24",
#             "Description": "Backend-b (gateway)"
#         }
#     ]
# }

# ---------------------------------------------------------------------------
# STEP 2 -- Move the service to the backend subnets (keep SG, drop public IP)
# ---------------------------------------------------------------------------
#
# This triggers a rolling replacement; the new task lands in a backend subnet,
# its default route is the Return GW, and ECS re-registers its IP in the TG.

# echo "# Update fleetshell-gateway service network configuration"
# aws ecs update-service \
#   --cluster aeroftp-cluster \
#   --service fleetshell-gateway-service-jp7c7a8v \
#   --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_BACKEND_A},${SUBNET_BACKEND_B}],securityGroups=[${GATEWAY_SG}],assignPublicIp=DISABLED}" \
#   --region "${REGION}"

# RESULT
# # Update fleetshell-gateway service network configuration
# {
#     "service": {
#         "serviceArn": "arn:aws:ecs:eu-west-2:295934382486:service/aeroftp-cluster/fleetshell-gateway-service-jp7c7a8v",
#         "serviceName": "fleetshell-gateway-service-jp7c7a8v",
#         "clusterArn": "arn:aws:ecs:eu-west-2:295934382486:cluster/aeroftp-cluster",
#         "loadBalancers": [
#             {
#                 "targetGroupArn": "arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce",
#                 "containerName": "fleetshell-gateway",
#                 "containerPort": 8443
#             }
#         ],
#         "serviceRegistries": [],
#         "status": "ACTIVE",
#         "desiredCount": 2,
#         "runningCount": 1,
#         "pendingCount": 0,
#         "capacityProviderStrategy": [
#             {
#                 "capacityProvider": "FARGATE",
#                 "weight": 1,
#                 "base": 0
#             }
#         ],
#         "platformVersion": "1.4.0",
#         "platformFamily": "Linux",
#         "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-gateway:14",
#         "deploymentConfiguration": {
#             "deploymentCircuitBreaker": {
#                 "enable": true,
#                 "rollback": true
#             },
#             "maximumPercent": 200,
#             "minimumHealthyPercent": 100
#         },
#         "deployments": [
#             {
#                 "id": "ecs-svc/2868022798482981641",
#                 "status": "PRIMARY",
#                 "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-gateway:14",
#                 "desiredCount": 0,
#                 "pendingCount": 0,
#                 "runningCount": 0,
#                 "failedTasks": 0,
#                 "createdAt": "2026-08-10T12:26:18.620000+02:00",
#                 "updatedAt": "2026-08-10T12:26:18.620000+02:00",
#                 "capacityProviderStrategy": [
#                     {
#                         "capacityProvider": "FARGATE",
#                         "weight": 1,
#                         "base": 0
#                     }
#                 ],
#                 "platformVersion": "1.4.0",
#                 "platformFamily": "Linux",
#                 "networkConfiguration": {
#                     "awsvpcConfiguration": {
#                         "subnets": [
#                             "subnet-01a513292ea15ae83",
#                             "subnet-08213d03f2940855c"
#                         ],
#                         "securityGroups": [
#                             "sg-065f9193da9f46436"
#                         ],
#                         "assignPublicIp": "DISABLED"
#                     }
#                 },
#                 "rolloutState": "IN_PROGRESS",
#                 "rolloutStateReason": "ECS deployment ecs-svc/2868022798482981641 in progress."
#             },
#             {
#                 "id": "ecs-svc/9249720185770379859",
#                 "status": "ACTIVE",
#                 "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-gateway:14",
#                 "desiredCount": 2,
#                 "pendingCount": 0,
#                 "runningCount": 1,
#                 "failedTasks": 0,
#                 "createdAt": "2026-07-31T18:09:08.608000+02:00",
#                 "updatedAt": "2026-08-10T12:21:45.648000+02:00",
#                 "capacityProviderStrategy": [
#                     {
#                         "capacityProvider": "FARGATE",
#                         "weight": 1,
#                         "base": 0
#                     }
#                 ],
#                 "platformVersion": "1.4.0",
#                 "platformFamily": "Linux",
#                 "networkConfiguration": {
#                     "awsvpcConfiguration": {
#                         "subnets": [
#                             "subnet-0dda17fa00b5100ed"
#                         ],
#                         "securityGroups": [
#                             "sg-065f9193da9f46436"
#                         ],
#                         "assignPublicIp": "ENABLED"
#                     }
#                 },
#                 "rolloutState": "COMPLETED",
#                 "rolloutStateReason": "ECS deployment ecs-svc/9249720185770379859 completed."
#             }
#         ],
#         "roleArn": "arn:aws:iam::295934382486:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS",
#         "events": [
#             {
#                 "id": "ede59bf9-c7e8-47ec-936b-2babd2283537",
#                 "createdAt": "2026-08-10T12:26:07.363000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: unable to retrieve secret from asm: There is a connection issue between the task and AWS Secrets Manager. Check your task network configuration. failed to fetch secret arn:aws:secretsmanager:eu-west-2:295934382486:secret:aerotrack/auth_secret-zTocUO from secrets manager: operation error Secrets Manager: GetSecretValue, https response error StatusCode: 0, RequestID: , canceled, context deadline exceeded."
#             },
#             {
#                 "id": "3585b20a-da09-4554-be08-313e7d2911de",
#                 "createdAt": "2026-08-10T12:21:46.286000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has started 1 tasks: (task 1ab244f555e548f98df398ecbf50bd24)."
#             },
#             {
#                 "id": "a35329c8-a12d-464d-8b15-78920f1dfea8",
#                 "createdAt": "2026-08-10T11:52:57.518000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "a72d7dd8-ac14-47f8-bfc9-de639347d17e",
#                 "createdAt": "2026-08-10T05:52:53.391000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "4b06d095-dd9d-4cfc-865a-bae3dd8834a0",
#                 "createdAt": "2026-08-09T23:52:26.275000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "0347c2e8-264f-4ccb-96e5-d579764ec1cf",
#                 "createdAt": "2026-08-09T17:52:13.804000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "43c6ea37-3e2f-4d48-93f7-5caf1fe0b74e",
#                 "createdAt": "2026-08-09T11:51:45.977000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "616d98d3-cdcb-470d-a9d6-646a7aeff268",
#                 "createdAt": "2026-08-09T05:51:09.660000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "d29a2871-1355-49c7-ba11-5f6d72cc9ca3",
#                 "createdAt": "2026-08-08T23:50:56.306000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "7ccd772b-96f5-4289-8e45-d488dc4adcfd",
#                 "createdAt": "2026-08-08T17:50:22.132000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "1826d1ae-19f3-40ab-96e1-9dbfecfc42b0",
#                 "createdAt": "2026-08-08T11:50:09.907000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "13c07f14-4b19-4408-a36c-ab19d14629b0",
#                 "createdAt": "2026-08-08T05:49:29.960000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "2e9a13ae-9290-4142-b4ee-9a19182e2ed1",
#                 "createdAt": "2026-08-07T23:48:54.581000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "ec9163c1-c786-4a17-900e-4d50c643dde3",
#                 "createdAt": "2026-08-07T20:24:55.261000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "1b9bf962-1224-48c6-9841-3ce88c5240ce",
#                 "createdAt": "2026-08-07T16:10:17.920000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "11ef2ba8-000b-4334-a6c3-637ee7ae90a6",
#                 "createdAt": "2026-08-07T11:57:21.215000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "95486734-9a89-4adb-8f5d-ecc325a07d13",
#                 "createdAt": "2026-08-07T05:57:18.765000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "f462897c-a162-471a-b24d-3871bbe1bbe0",
#                 "createdAt": "2026-08-06T23:56:38.591000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "1623a5f7-4100-48e4-84a7-c7679dd80981",
#                 "createdAt": "2026-08-06T17:56:38.100000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "d2d78de2-896c-45fb-9ac5-f64894a9c287",
#                 "createdAt": "2026-08-06T11:56:16.240000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "762e11ea-64b5-47ae-a65a-ec2b5f1e04de",
#                 "createdAt": "2026-08-06T05:55:55.992000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "9ab720fd-94b8-4deb-9311-e14579c29986",
#                 "createdAt": "2026-08-05T23:55:10.612000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "31eb1c10-a820-4352-924c-9c746696fe91",
#                 "createdAt": "2026-08-05T17:54:45.972000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "eb698b9b-e8da-4985-9a4a-4bcaadedb1e5",
#                 "createdAt": "2026-08-05T11:54:03.142000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "0cd07319-561b-43f6-88aa-aa18efe6b7af",
#                 "createdAt": "2026-08-05T05:53:39.005000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "32382620-99b3-4972-b016-2674925b89f0",
#                 "createdAt": "2026-08-04T23:53:20.868000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "9ccffbc4-776d-43e1-8973-fb02565dbdb4",
#                 "createdAt": "2026-08-04T17:52:54.316000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "0fdfda42-25f3-4e9d-be4b-919582e4c8c3",
#                 "createdAt": "2026-08-04T11:52:39.070000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "a7007ace-d5cf-47c1-b9e0-1739249603fa",
#                 "createdAt": "2026-08-04T05:52:02.786000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "644b7941-a1cd-4edd-be5e-c45682094fa7",
#                 "createdAt": "2026-08-03T23:51:24.864000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "de65670b-07fe-41a9-9903-c1fa4db04d6c",
#                 "createdAt": "2026-08-03T23:31:00.064000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "9eb181f2-f99c-4204-b4ca-114ed92ecca0",
#                 "createdAt": "2026-08-03T19:11:06.362000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "2734282d-d024-43a8-81de-1be94091af5a",
#                 "createdAt": "2026-08-03T15:18:03.559000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "7ea3934e-d74a-4822-baad-326c4571d62d",
#                 "createdAt": "2026-08-03T12:15:07.205000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "bd6c68ca-dcad-4c27-bffd-f99e64b42808",
#                 "createdAt": "2026-08-03T06:14:55.617000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "f396fe64-ba4d-4a41-9cab-d7e861058ee1",
#                 "createdAt": "2026-08-03T00:14:25.116000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "5d4ed292-b5d2-4851-aa6b-5b1ca4ca9b48",
#                 "createdAt": "2026-08-02T18:13:48.135000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "3c02765f-23a9-4df4-8355-5973617ff44b",
#                 "createdAt": "2026-08-02T12:13:36.976000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "93e8d6a5-db8e-4d88-98d6-e09d5361e671",
#                 "createdAt": "2026-08-02T06:13:26.334000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "72414177-d3a1-4e52-9039-37aac608266f",
#                 "createdAt": "2026-08-02T00:13:12.290000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "90609b72-5fc1-47ba-8984-84cff9f52706",
#                 "createdAt": "2026-08-01T18:12:42.649000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "f82da8ca-732c-4c41-981f-812c65200bbb",
#                 "createdAt": "2026-08-01T12:12:13.647000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "198d5c8d-6833-4bc5-a49e-d1042e92fb1c",
#                 "createdAt": "2026-08-01T06:11:35.735000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "feea333a-7f07-49b3-8fb1-bd023167f7ca",
#                 "createdAt": "2026-08-01T00:10:54.432000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "2a5b5062-5417-4551-a9bd-2d8e816280d1",
#                 "createdAt": "2026-07-31T18:11:28.817000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "21e7c388-53fd-421f-9080-a11c18f7a66f",
#                 "createdAt": "2026-07-31T18:11:28.816000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) (deployment ecs-svc/9249720185770379859) deployment completed."
#             },
#             {
#                 "id": "9114988c-3a8c-482a-910b-2b9ca2fed42a",
#                 "createdAt": "2026-07-31T18:10:36.680000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v, taskSet ecs-svc/7195393876234550169) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "6b9c0c4e-7c10-429f-b1a1-efaa9f22ea24",
#                 "createdAt": "2026-07-31T18:10:36.675000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "ada6b0a1-ff64-46eb-8009-16901f5744e9",
#                 "createdAt": "2026-07-31T18:10:27.035000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has stopped 1 running tasks: (task 9ff84cd0d35c43178af3bd674b5c9f24)."
#             },
#             {
#                 "id": "11a6fe66-0d6e-4cef-acfe-e887f962ae9d",
#                 "createdAt": "2026-07-31T18:09:45.093000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "9092357f-c22c-4d45-8203-249948d752d4",
#                 "createdAt": "2026-07-31T18:09:15.209000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has started 1 tasks: (task 73d27568abd945e49c66d2f87f743e89)."
#             },
#             {
#                 "id": "1833d641-d3e9-4419-8279-9d329655f6fa",
#                 "createdAt": "2026-07-31T17:12:59.051000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "e7ce954c-6172-47b5-93cd-2be5001e4681",
#                 "createdAt": "2026-07-31T17:12:59.050000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) (deployment ecs-svc/7195393876234550169) deployment completed."
#             },
#             {
#                 "id": "0f92964d-ecff-4659-b04a-94d65894c961",
#                 "createdAt": "2026-07-31T17:11:56.766000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v, taskSet ecs-svc/2474545631753893222) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "e2562870-c568-4682-84a0-7dc6eb430916",
#                 "createdAt": "2026-07-31T17:11:56.761000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "83238566-9739-4b88-869f-73a599d3accf",
#                 "createdAt": "2026-07-31T17:11:47.229000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has stopped 1 running tasks: (task e4390e80991142b19703f321692a133e)."
#             },
#             {
#                 "id": "a85ce663-b83e-4b52-9c8f-7adf444c2357",
#                 "createdAt": "2026-07-31T17:11:06.641000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "c19e6188-51f7-460c-8e4f-4de1db626071",
#                 "createdAt": "2026-07-31T17:10:36.635000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has started 1 tasks: (task 9ff84cd0d35c43178af3bd674b5c9f24)."
#             },
#             {
#                 "id": "50a422a6-fd01-4cac-a286-207f86f02705",
#                 "createdAt": "2026-07-31T16:57:52.325000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "218dc1a6-f0f2-44ae-b070-0236dd3eb4d9",
#                 "createdAt": "2026-07-31T16:57:52.324000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) (deployment ecs-svc/2474545631753893222) deployment completed."
#             },
#             {
#                 "id": "2c5cdf16-f400-4074-a4a2-a5ea5a65cd6a",
#                 "createdAt": "2026-07-31T16:56:59.387000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v, taskSet ecs-svc/5564087496555347477) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "120f9aba-965b-4c7c-9bb4-eaa47beaf758",
#                 "createdAt": "2026-07-31T16:56:59.384000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "17e22f2f-eb39-426c-9ff3-4ba2b48a0fb5",
#                 "createdAt": "2026-07-31T16:56:49.644000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has stopped 1 running tasks: (task 6e61223e68fc424b94f623739a6083d2)."
#             },
#             {
#                 "id": "cf0798e6-124e-4ce1-9afd-ed9770786ad2",
#                 "createdAt": "2026-07-31T16:56:08.617000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "87f0b235-5737-4d56-a576-a1a2eb867940",
#                 "createdAt": "2026-07-31T16:55:38.227000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has started 1 tasks: (task e4390e80991142b19703f321692a133e)."
#             },
#             {
#                 "id": "61d39b1b-cc89-4271-a6b5-b5154df815d9",
#                 "createdAt": "2026-07-31T16:43:34.711000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "1ec515ee-fc4a-4996-849d-6652737e8a62",
#                 "createdAt": "2026-07-31T16:43:34.710000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) (deployment ecs-svc/5564087496555347477) deployment completed."
#             },
#             {
#                 "id": "da378d4e-6f15-4814-abb1-70e94b79966f",
#                 "createdAt": "2026-07-31T16:42:33.332000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v, taskSet ecs-svc/4243413092896444636) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "a44d25cb-036e-42bc-ba9a-83b52df7fbe9",
#                 "createdAt": "2026-07-31T16:42:33.328000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "2b4e9f25-6f64-4ee7-baad-f79552f41108",
#                 "createdAt": "2026-07-31T16:42:22.478000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has stopped 1 running tasks: (task a2131345fca64471b9a70de01ae966bd)."
#             },
#             {
#                 "id": "a7b2f5fa-b7a4-41ef-88b6-a6cb203ead2f",
#                 "createdAt": "2026-07-31T16:41:41.396000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "ccb29d21-bb82-4cde-9692-d3a2d9f61b32",
#                 "createdAt": "2026-07-31T16:41:10.659000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has started 1 tasks: (task 6e61223e68fc424b94f623739a6083d2)."
#             },
#             {
#                 "id": "1444c41d-7c0e-47a6-8156-073d080f5826",
#                 "createdAt": "2026-07-31T16:05:14.835000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "055b15a8-a461-4ca8-90ff-6c7f48ce600b",
#                 "createdAt": "2026-07-31T16:05:14.834000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) (deployment ecs-svc/4243413092896444636) deployment completed."
#             },
#             {
#                 "id": "3a095eeb-da74-4e53-b2db-1de0a348ec89",
#                 "createdAt": "2026-07-31T16:04:22.818000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v, taskSet ecs-svc/5005259556283076149) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "d187e271-d88a-426a-9b00-9d8fff1dd24e",
#                 "createdAt": "2026-07-31T16:04:22.794000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "837008e8-d625-4057-ab26-60023a1b1f19",
#                 "createdAt": "2026-07-31T16:04:12.162000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has stopped 1 running tasks: (task 8fcf3bc9bb244170a4bf3101171e2977)."
#             },
#             {
#                 "id": "36a237e2-2f04-4670-8b80-ce7121047f0e",
#                 "createdAt": "2026-07-31T16:03:31.160000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "d780b49a-fed8-405d-a1ac-09abcda194ea",
#                 "createdAt": "2026-07-31T16:03:00.526000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has started 1 tasks: (task a2131345fca64471b9a70de01ae966bd)."
#             },
#             {
#                 "id": "b4f410cf-3e4a-42ad-9556-61b5fbc514d4",
#                 "createdAt": "2026-07-31T15:43:25.803000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "39e28b12-c129-4bdb-84e4-c8c28a72323f",
#                 "createdAt": "2026-07-31T15:21:15.942000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "3ac64f4b-1265-4b3f-b3f5-df0b7f0a72ab",
#                 "createdAt": "2026-07-31T14:34:57.609000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "539cdfb1-0fe9-4c01-8e33-57981cfe9584",
#                 "createdAt": "2026-07-31T14:34:57.608000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) (deployment ecs-svc/5005259556283076149) deployment completed."
#             },
#             {
#                 "id": "094005b5-bd9b-4fb8-8d87-042a1338be87",
#                 "createdAt": "2026-07-31T14:34:05.279000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v, taskSet ecs-svc/5912346706821285827) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "83bdba50-d614-4687-be37-4076483ff4d7",
#                 "createdAt": "2026-07-31T14:34:05.259000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "e72fa97b-600b-4660-8398-53da5a0fbfeb",
#                 "createdAt": "2026-07-31T14:33:54.698000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has stopped 1 running tasks: (task 29a5f333e216453db9dba5185b8e14b0)."
#             },
#             {
#                 "id": "7d58c9db-3c78-47dc-a361-9e3ddf121fe0",
#                 "createdAt": "2026-07-31T14:33:14.411000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "453bfab2-c5a6-4f27-9761-d66e2b4522fb",
#                 "createdAt": "2026-07-31T14:32:42.864000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has started 1 tasks: (task 8fcf3bc9bb244170a4bf3101171e2977)."
#             },
#             {
#                 "id": "f286dbcb-b3bd-4226-b6f7-1b0baf7c2156",
#                 "createdAt": "2026-07-31T13:26:03.782000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "fe338251-a6cc-4c6e-a381-c5fccebb3956",
#                 "createdAt": "2026-07-31T13:26:03.781000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) (deployment ecs-svc/5912346706821285827) deployment completed."
#             },
#             {
#                 "id": "3ffd801b-f9d2-4eef-86ae-a2a7f315bf5f",
#                 "createdAt": "2026-07-31T13:25:10.736000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v, taskSet ecs-svc/0292668567160354735) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "bcce0a6e-b331-4702-8629-e16f91c6caad",
#                 "createdAt": "2026-07-31T13:25:10.730000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "0950d767-5e5a-49b3-9e19-39bb8d222bdf",
#                 "createdAt": "2026-07-31T13:25:01.268000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has stopped 1 running tasks: (task af5b17f4e3aa448e904adc6c7f081452)."
#             },
#             {
#                 "id": "87926baf-0a71-46e8-86e6-6d5b36d2738e",
#                 "createdAt": "2026-07-31T13:24:20.385000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "0daed853-d485-4ce4-811a-5612aff69d6c",
#                 "createdAt": "2026-07-31T13:23:49.749000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has started 1 tasks: (task 29a5f333e216453db9dba5185b8e14b0)."
#             },
#             {
#                 "id": "45803811-a297-4f5b-bfff-4b77090c09da",
#                 "createdAt": "2026-07-31T13:11:56.667000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has reached a steady state."
#             },
#             {
#                 "id": "8139a696-405f-41c8-b642-4a9f365320dc",
#                 "createdAt": "2026-07-31T13:11:56.666000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) (deployment ecs-svc/0292668567160354735) deployment completed."
#             },
#             {
#                 "id": "d8d6f088-bb5c-473e-8a77-b4c75c8659cc",
#                 "createdAt": "2026-07-31T13:10:55.920000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v, taskSet ecs-svc/2415100545545773798) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "38cf4957-d257-4759-adda-526772ce6efb",
#                 "createdAt": "2026-07-31T13:10:55.899000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce)"
#             },
#             {
#                 "id": "c7140cae-8f7a-4740-964e-3d1af38c1a0e",
#                 "createdAt": "2026-07-31T13:10:45.847000+02:00",
#                 "message": "(service fleetshell-gateway-service-jp7c7a8v) has stopped 1 running tasks: (task 4280ac1608434bac80b3c4a97f3d80eb)."
#             }
#         ],
#         "createdAt": "2026-07-22T10:37:59.829000+02:00",
#         "placementConstraints": [],
#         "placementStrategy": [],
#         "networkConfiguration": {
#             "awsvpcConfiguration": {
#                 "subnets": [
#                     "subnet-01a513292ea15ae83",
#                     "subnet-08213d03f2940855c"
#                 ],
#                 "securityGroups": [
#                     "sg-065f9193da9f46436"
#                 ],
#                 "assignPublicIp": "DISABLED"
#             }
#         },
#         "healthCheckGracePeriodSeconds": 0,
#         "schedulingStrategy": "REPLICA",
#         "deploymentController": {
#             "type": "ECS"
#         },
#         "createdBy": "arn:aws:iam::295934382486:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_CLI-Role-PowerUserAndVPC_3a45f6c9035e1a71",
#         "enableECSManagedTags": true,
#         "propagateTags": "NONE",
#         "enableExecuteCommand": true
#     }
# }


# Verify:
  # aws ecs describe-services --cluster aeroftp-cluster \
  #   --services fleetshell-gateway-service-jp7c7a8v --region eu-west-2 \
  #   --query 'services[0].deployments'
  # aws elbv2 describe-target-health \
  #   --target-group-arn arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-gateway-tg/45d0ca6be8c31dce \
  #   --region eu-west-2 \
  #   --query 'TargetHealthDescriptions[].{Id:Target.Id,AZ:Target.AvailabilityZone,State:TargetHealth.State}'
# New target IP should be 172.16.53.x or 172.16.54.x and go healthy.

# ---------------------------------------------------------------------------
# STEP 3 (recommended) -- NLB cross-zone, because desiredCount=1
# ---------------------------------------------------------------------------
#
# Cross-zone is currently DISABLED, so only the NLB node in the SAME AZ as the
# single task can reach it; the other AZ's NLB IP is dead.  Enable cross-zone so
# one task serves both NLB IPs (small inter-AZ data cost).  Alternatively run
# desiredCount=2 (one per AZ) or pin STEP 2 to a single backend subnet.

# echo "# Enable NLB cross-zone load balancing"
# aws elbv2 modify-load-balancer-attributes \
#   --load-balancer-arn arn:aws:elasticloadbalancing:eu-west-2:295934382486:loadbalancer/net/fleetshell-gateway-nlb/76b8a5afb99bae59 \
#   --attributes Key=load_balancing.cross_zone.enabled,Value=true \
#   --region "${REGION}"

# RESULT
# done manually via GUI
