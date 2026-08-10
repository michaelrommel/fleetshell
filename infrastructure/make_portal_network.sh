#!/usr/bin/env bash
set -euo pipefail
#
# make_portal_network.sh
#
# Dedicated network + security group for the fleetshell-portal ECS/Fargate
# service, isolated from the IPSec backend subnets.
#
# WHY THIS EXISTS
# ---------------
# The backend work (make_vpc_endpoints_backend.sh) created VPC *interface*
# endpoints for ecr.api / ecr.dkr / ssm / ssmmessages / ec2messages with
# PrivateDnsEnabled=true.  Private DNS is VPC-WIDE: every task in the VPC now
# resolves api.ecr.eu-west-2.amazonaws.com (and the dkr layer host) to the
# private endpoint ENIs in 172.16.53.x / 172.16.54.x instead of the public ECR
# IPs reached via the Internet Gateway.
#
# The portal runs in the public subnet AeroFTP-subnet-public2-eu-west-2b
# (172.16.16.0/20).  Its source IP is NOT in the backend CIDRs, so the endpoint
# SG (FleetShell-IPSec-sg-endpoints, sg-0438c989d6fe0f276 -- allows 443 only
# from 172.16.53.0/24 and 172.16.54.0/24) drops the connection.  Result:
#
#   ResourceInitializationError: unable to pull secrets or registry auth:
#   ... GetAuthorizationToken ... dial tcp 172.16.54.241:443: i/o timeout
#
# The old task keeps running only because it already cached the image layers.
#
# FIX MODEL
# ---------
# Because private DNS cannot be disabled per-subnet, a new subnet alone does NOT
# help -- the portal will still resolve ECR to the private endpoints.  So we:
#   1. Create dedicated PUBLIC portal subnets (one per AZ) with a route table
#      whose default route is the Internet Gateway (keeps Secrets Manager +
#      general egress working exactly as before; assignPublicIp stays ENABLED).
#   2. Create a dedicated portal task SG (ALB ingress on 3000/8443 only).
#   3. Allow the portal SUBNET CIDRs inbound 443 on the endpoint SG so ECR/SSM
#      private endpoints accept the portal (this is the actual break-fix).
#   4. Add the new portal SG to the Valkey/MemoryDB 6379 rule (that rule lives
#      on sg-0709bc00b444b3a9a, of which the MemoryDB node is a member).
#   5. Point the ECS service at the new subnets + SG.
#
# Endpoint ENIs exist in BOTH AZs (a: 172.16.53.105 / b: 172.16.54.241 for
# ecr.api), so a portal task in either AZ finds a local endpoint.

REGION="eu-west-2"
VPC_ID="vpc-0595e17ce290fb050"
IGW_ID="igw-0599736bc51a9ac5c"

# Existing SGs we reference:
ENDPOINTS_SG="sg-0438c989d6fe0f276"   # FleetShell-IPSec-sg-endpoints (ECR/SSM interface endpoints)
VALKEY_SG="sg-0709bc00b444b3a9a"      # fleetshell-task == MemoryDB SG (holds the 6379 self-rule)
ALB_SG_1="sg-0a29113f0d29e4adf"       # CLI_WebAccess
ALB_SG_2="sg-07a9690f85109722a"       # aerotrack-alb

# New portal CIDRs (verified unused in vpc-0595e17ce290fb050):
PORTAL_CIDR_A="172.16.55.0/24"        # eu-west-2a
PORTAL_CIDR_B="172.16.56.0/24"        # eu-west-2b

# ---------------------------------------------------------------------------
# STEP 1 -- Dedicated portal subnets (one per AZ)
# ---------------------------------------------------------------------------

# echo "# Portal subnet -- AZ-a (eu-west-2a)"
# aws ec2 create-subnet \
#   --vpc-id "${VPC_ID}" \
#   --cidr-block "${PORTAL_CIDR_A}" \
#   --availability-zone eu-west-2a \
#   --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=FleetShell-portal-a}]' \
#   --region "${REGION}"

# echo "# Portal subnet -- AZ-b (eu-west-2b)"
# aws ec2 create-subnet \
#   --vpc-id "${VPC_ID}" \
#   --cidr-block "${PORTAL_CIDR_B}" \
#   --availability-zone eu-west-2b \
#   --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=FleetShell-portal-b}]' \
#   --region "${REGION}"

# RESULT

# # Portal subnet -- AZ-a (eu-west-2a)
# {
#     "Subnet": {
#         "AvailabilityZone": "eu-west-2a",
#         "AvailabilityZoneId": "euw2-az2",
#         "AvailableIpAddressCount": 251,
#         "CidrBlock": "172.16.55.0/24",
#         "DefaultForAz": false,
#         "MapPublicIpOnLaunch": false,
#         "MapCustomerOwnedIpOnLaunch": false,
#         "State": "available",
#         "SubnetId": "subnet-0f1518686a5653072",
#         "VpcId": "vpc-0595e17ce290fb050",
#         "OwnerId": "295934382486",
#         "AssignIpv6AddressOnCreation": false,
#         "Ipv6CidrBlockAssociationSet": [],
#         "Tags": [
#             {
#                 "Key": "Name",
#                 "Value": "FleetShell-portal-a"
#             }
#         ],
#         "SubnetArn": "arn:aws:ec2:eu-west-2:295934382486:subnet/subnet-0f1518686a5653072",
#         "EnableDns64": false,
#         "Ipv6Native": false,
#         "PrivateDnsNameOptionsOnLaunch": {
#             "HostnameType": "ip-name",
#             "EnableResourceNameDnsARecord": false,
#             "EnableResourceNameDnsAAAARecord": false
#         }
#     }
# }
# # Portal subnet -- AZ-b (eu-west-2b)
# {
#     "Subnet": {
#         "AvailabilityZone": "eu-west-2b",
#         "AvailabilityZoneId": "euw2-az3",
#         "AvailableIpAddressCount": 251,
#         "CidrBlock": "172.16.56.0/24",
#         "DefaultForAz": false,
#         "MapPublicIpOnLaunch": false,
#         "MapCustomerOwnedIpOnLaunch": false,
#         "State": "available",
#         "SubnetId": "subnet-0a36ff714c911de66",
#         "VpcId": "vpc-0595e17ce290fb050",
#         "OwnerId": "295934382486",
#         "AssignIpv6AddressOnCreation": false,
#         "Ipv6CidrBlockAssociationSet": [],
#         "Tags": [
#             {
#                 "Key": "Name",
#                 "Value": "FleetShell-portal-b"
#             }
#         ],
#         "SubnetArn": "arn:aws:ec2:eu-west-2:295934382486:subnet/subnet-0a36ff714c911de66",
#         "EnableDns64": false,
#         "Ipv6Native": false,
#         "PrivateDnsNameOptionsOnLaunch": {
#             "HostnameType": "ip-name",
#             "EnableResourceNameDnsARecord": false,
#             "EnableResourceNameDnsAAAARecord": false
#         }
#     }
# }

# Capture the SubnetIds printed above:
SUBNET_PORTAL_A="subnet-0f1518686a5653072"   # <- fill from RESULT (eu-west-2a)
SUBNET_PORTAL_B="subnet-0a36ff714c911de66"   # <- fill from RESULT (eu-west-2b)

# Fargate needs a public IP for IGW egress; ensure auto-assign is on for both
# (assignPublicIp=ENABLED on the service also forces this, but keep the subnet
# consistent).
# echo "# Enable auto-assign public IP on portal subnets"
# aws ec2 modify-subnet-attribute --subnet-id "${SUBNET_PORTAL_A}" --map-public-ip-on-launch --region "${REGION}"
# aws ec2 modify-subnet-attribute --subnet-id "${SUBNET_PORTAL_B}" --map-public-ip-on-launch --region "${REGION}"

# RESULT
# none

# ---------------------------------------------------------------------------
# STEP 2 -- Dedicated route table for the portal subnets (default via IGW)
# ---------------------------------------------------------------------------
#
# Keeps Secrets Manager + general internet egress working (as today).  ECR now
# resolves to the private endpoints via the local 172.16.0.0/16 route; ECR
# image-layer S3 fetches go out via the IGW (no S3 gateway endpoint needed on
# this RTB -- that mirrors the portal's current behaviour).

# echo "# Create portal route table"
# aws ec2 create-route-table \
#   --vpc-id "${VPC_ID}" \
#   --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=FleetShell-portal-rtb}]' \
#   --region "${REGION}"

# RESULT
# # Create portal route table
# {
#     "RouteTable": {
#         "Associations": [],
#         "PropagatingVgws": [],
#         "RouteTableId": "rtb-0d94176aa026639df",
#         "Routes": [
#             {
#                 "DestinationCidrBlock": "172.16.0.0/16",
#                 "GatewayId": "local",
#                 "Origin": "CreateRouteTable",
#                 "State": "active"
#             },
#             {
#                 "DestinationIpv6CidrBlock": "2a05:d01c:613:7200::/56",
#                 "GatewayId": "local",
#                 "Origin": "CreateRouteTable",
#                 "State": "active"
#             }
#         ],
#         "Tags": [
#             {
#                 "Key": "Name",
#                 "Value": "FleetShell-portal-rtb"
#             }
#         ],
#         "VpcId": "vpc-0595e17ce290fb050",
#         "OwnerId": "295934382486"
#     },
#     "ClientToken": "cdaabf76-9936-4f44-ba83-abcad559d546"
# }


RTB_PORTAL="rtb-0d94176aa026639df"   # <- fill from RESULT

# echo "# Default route -> Internet Gateway"
# aws ec2 create-route \
#   --route-table-id "${RTB_PORTAL}" \
#   --destination-cidr-block 0.0.0.0/0 \
#   --gateway-id "${IGW_ID}" \
#   --region "${REGION}"

# echo "# Associate both portal subnets with the portal RTB"
# aws ec2 associate-route-table --route-table-id "${RTB_PORTAL}" --subnet-id "${SUBNET_PORTAL_A}" --region "${REGION}"
# aws ec2 associate-route-table --route-table-id "${RTB_PORTAL}" --subnet-id "${SUBNET_PORTAL_B}" --region "${REGION}"

# RESULT
# Associate both portal subnets with the portal RTB
# {
#     "AssociationId": "rtbassoc-0fa054ab2d767355b",
#     "AssociationState": {
#         "State": "associated"
#     }
# }
# {
#     "AssociationId": "rtbassoc-007b4fdc88b5610b6",
#     "AssociationState": {
#         "State": "associated"
#     }
# }

# ---------------------------------------------------------------------------
# STEP 3 -- Dedicated portal task security group
# ---------------------------------------------------------------------------
#
# Ingress: 3000 and 8443 from the two ALB SGs (matches the current
# fleetshell-task rules).  Egress: all.  Valkey 6379 is handled in STEP 5 by a
# rule ON the MemoryDB SG referencing this new SG (not a self-rule here).

# echo "# Create portal task SG"
# aws ec2 create-security-group \
#   --vpc-id "${VPC_ID}" \
#   --group-name FleetShell-portal-task \
#   --description "fleetshell-portal Fargate task: ALB ingress only, isolated from IPSec backend" \
#   --tag-specifications 'ResourceType=security-group,Tags=[{Key=Name,Value=FleetShell-portal-task}]' \
#   --region "${REGION}"

# RESULT
# # Create portal task SG
# {
#     "GroupId": "sg-091e067dceceafc4b",
#     "Tags": [
#         {
#             "Key": "Name",
#             "Value": "FleetShell-portal-task"
#         }
#     ]
# }

PORTAL_SG="sg-091e067dceceafc4b"   # <- fill from RESULT

# echo "# Ingress 3000 (web service for ALB) from both ALB SGs"
# aws ec2 authorize-security-group-ingress --group-id "${PORTAL_SG}" \
#   --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":3000,\"ToPort\":3000,\"UserIdGroupPairs\":[{\"GroupId\":\"${ALB_SG_1}\",\"Description\":\"Web Service for ALB (CLI_WebAccess)\"},{\"GroupId\":\"${ALB_SG_2}\",\"Description\":\"Web Service for ALB (aerotrack-alb)\"}]}]" \
#   --region "${REGION}"

# NOTE: skipped for now
# echo "# Ingress 8443 from both ALB SGs"
# aws ec2 authorize-security-group-ingress --group-id "${PORTAL_SG}" \
#   --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":8443,\"ToPort\":8443,\"UserIdGroupPairs\":[{\"GroupId\":\"${ALB_SG_1}\"},{\"GroupId\":\"${ALB_SG_2}\"}]}]" \
#   --region "${REGION}"

# RESULT
# # Ingress 3000 (web service for ALB) from both ALB SGs
# {
#     "Return": true,
#     "SecurityGroupRules": [
#         {
#             "SecurityGroupRuleId": "sgr-0303a1fb5e5d53727",
#             "GroupId": "sg-091e067dceceafc4b",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 3000,
#             "ToPort": 3000,
#             "ReferencedGroupInfo": {
#                 "GroupId": "sg-0a29113f0d29e4adf",
#                 "UserId": "295934382486"
#             },
#             "Description": "Web Service for ALB (CLI_WebAccess)"
#         },
#         {
#             "SecurityGroupRuleId": "sgr-09cb385ffc73b5609",
#             "GroupId": "sg-091e067dceceafc4b",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 3000,
#             "ToPort": 3000,
#             "ReferencedGroupInfo": {
#                 "GroupId": "sg-07a9690f85109722a",
#                 "UserId": "295934382486"
#             },
#             "Description": "Web Service for ALB (aerotrack-alb)"
#         }
#     ]
# }

#
# NOTE: a new SG already has an implicit allow-all egress rule, so no egress
# authorize call is needed.

# ---------------------------------------------------------------------------
# STEP 4 -- Allow the portal subnets on the ECR/SSM interface endpoint SG
# ---------------------------------------------------------------------------
#
# THIS IS THE ACTUAL BREAK-FIX.  Without it the portal (in any subnet of this
# VPC) still cannot reach the private ECR endpoints.

# echo "# Allow HTTPS from portal subnets to the interface endpoints"
# aws ec2 authorize-security-group-ingress --group-id "${ENDPOINTS_SG}" \
#   --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":443,\"ToPort\":443,\"IpRanges\":[{\"CidrIp\":\"${PORTAL_CIDR_A}\",\"Description\":\"Portal-a\"},{\"CidrIp\":\"${PORTAL_CIDR_B}\",\"Description\":\"Portal-b\"}]}]" \
#   --region "${REGION}"

# RESULT
# # Allow HTTPS from portal subnets to the interface endpoints
# {
#     "Return": true,
#     "SecurityGroupRules": [
#         {
#             "SecurityGroupRuleId": "sgr-018ee188df0c635e1",
#             "GroupId": "sg-0438c989d6fe0f276",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 443,
#             "ToPort": 443,
#             "CidrIpv4": "172.16.55.0/24",
#             "Description": "Portal-a"
#         },
#         {
#             "SecurityGroupRuleId": "sgr-0c5805e198aec0bc1",
#             "GroupId": "sg-0438c989d6fe0f276",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 443,
#             "ToPort": 443,
#             "CidrIpv4": "172.16.56.0/24",
#             "Description": "Portal-b"
#         }
#     ]
# }


# ---------------------------------------------------------------------------
# STEP 5 -- Let the new portal SG reach Valkey/MemoryDB on 6379
# ---------------------------------------------------------------------------
#
# The MemoryDB node dev-valkey-aeroftp-0001-001 (172.16.139.251) is a member of
# sg-0709bc00b444b3a9a and its 6379 rule is self-referencing.  Add the new
# portal SG as an allowed source so the portal keeps Redis access after it
# leaves the old SG.

# echo "# Allow 6379 from the new portal SG on the Valkey/MemoryDB SG"
# aws ec2 authorize-security-group-ingress --group-id "${VALKEY_SG}" \
#   --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":6379,\"ToPort\":6379,\"UserIdGroupPairs\":[{\"GroupId\":\"${PORTAL_SG}\",\"Description\":\"Valkey DB from portal (dedicated SG)\"}]}]" \
#   --region "${REGION}"

# RESULT
# # Allow 6379 from the new portal SG on the Valkey/MemoryDB SG
# {
#     "Return": true,
#     "SecurityGroupRules": [
#         {
#             "SecurityGroupRuleId": "sgr-0108a86e6d3a64d83",
#             "GroupId": "sg-0709bc00b444b3a9a",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 6379,
#             "ToPort": 6379,
#             "ReferencedGroupInfo": {
#                 "GroupId": "sg-091e067dceceafc4b",
#                 "UserId": "295934382486"
#             },
#             "Description": "Valkey DB from portal (dedicated SG)"
#         }
#     ]
# }


# ---------------------------------------------------------------------------
# STEP 6 -- Point the ECS service at the new subnets + SG
# ---------------------------------------------------------------------------
#
# This triggers a rolling replacement; the new task now pulls from ECR through
# the allowed endpoints.  assignPublicIp stays ENABLED for IGW egress
# (Secrets Manager has no VPC endpoint).

# echo "# Update fleetshell-portal service network configuration"
# aws ecs update-service \
#   --cluster aeroftp-cluster \
#   --service fleetshell-portal-service-v6kb01vb \
#   --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_PORTAL_A},${SUBNET_PORTAL_B}],securityGroups=[${PORTAL_SG}],assignPublicIp=ENABLED}" \
#   --region "${REGION}"

# RESULT
# # Update fleetshell-portal service network configuration
# {
#     "service": {
#         "serviceArn": "arn:aws:ecs:eu-west-2:295934382486:service/aeroftp-cluster/fleetshell-portal-service-v6kb01vb",
#         "serviceName": "fleetshell-portal-service-v6kb01vb",
#         "clusterArn": "arn:aws:ecs:eu-west-2:295934382486:cluster/aeroftp-cluster",
#         "loadBalancers": [
#             {
#                 "targetGroupArn": "arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3",
#                 "containerName": "fleetshell-portal",
#                 "containerPort": 3000
#             }
#         ],
#         "serviceRegistries": [],
#         "status": "ACTIVE",
#         "desiredCount": 1,
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
#         "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:6",
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
#                 "id": "ecs-svc/5434307699940903438",
#                 "status": "PRIMARY",
#                 "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:6",
#                 "desiredCount": 0,
#                 "pendingCount": 0,
#                 "runningCount": 0,
#                 "failedTasks": 0,
#                 "createdAt": "2026-08-10T10:30:50.195000+02:00",
#                 "updatedAt": "2026-08-10T10:30:50.195000+02:00",
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
#                             "subnet-0a36ff714c911de66",
#                             "subnet-0f1518686a5653072"
#                         ],
#                         "securityGroups": [
#                             "sg-091e067dceceafc4b"
#                         ],
#                         "assignPublicIp": "ENABLED"
#                     }
#                 },
#                 "rolloutState": "IN_PROGRESS",
#                 "rolloutStateReason": "ECS deployment ecs-svc/5434307699940903438 in progress."
#             },
#             {
#                 "id": "ecs-svc/5482803233485152419",
#                 "status": "ACTIVE",
#                 "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:6",
#                 "desiredCount": 1,
#                 "pendingCount": 0,
#                 "runningCount": 1,
#                 "failedTasks": 0,
#                 "createdAt": "2026-07-31T19:27:41.829000+02:00",
#                 "updatedAt": "2026-08-10T10:08:09.223000+02:00",
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
#                             "subnet-0779b66ce8c3a599c"
#                         ],
#                         "securityGroups": [
#                             "sg-0709bc00b444b3a9a"
#                         ],
#                         "assignPublicIp": "ENABLED"
#                     }
#                 },
#                 "rolloutState": "COMPLETED",
#                 "rolloutStateReason": "ECS deployment ecs-svc/5482803233485152419 completed."
#             }
#         ],
#         "roleArn": "arn:aws:iam::295934382486:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS",
#         "events": [
#             {
#                 "id": "9d77aac5-7d14-47ae-a9af-8711c7f0b6a9",
#                 "createdAt": "2026-08-10T10:08:09.231000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "844a89d8-b845-4fe0-b17a-62990b4dc025",
#                 "createdAt": "2026-08-10T10:08:09.230000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/5482803233485152419) deployment completed."
#             },
#             {
#                 "id": "506b6071-117f-4f0a-8beb-615d95accca3",
#                 "createdAt": "2026-08-10T10:07:18.816000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) stopped 1 pending tasks."
#             },
#             {
#                 "id": "adf3a929-d40a-460a-9bc4-aa09070797d9",
#                 "createdAt": "2026-08-10T10:07:16.030000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) rolling back to deployment ecs-svc/5482803233485152419."
#             },
#             {
#                 "id": "01086b12-f92c-4deb-b86d-9c89168f499a",
#                 "createdAt": "2026-08-10T10:07:16.029000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/2905821670595576283) deployment failed: tasks failed to start."
#             },
#             {
#                 "id": "82812586-9de6-4aee-96e9-af65459a0df6",
#                 "createdAt": "2026-08-10T10:07:13.157000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task ec77ece6e6af44e6949fedeed09b8dfc)."
#             },
#             {
#                 "id": "138142d8-6ec9-45c6-a6c5-4200b1879f42",
#                 "createdAt": "2026-08-10T10:02:16.634000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: The task cannot pull registry auth from Amazon ECR: There is a connection issue between the task and Amazon ECR. Check your task network configuration. operation error ECR: GetAuthorizationToken, exceeded maximum number of attempts, 3, https response error StatusCode: 0, RequestID: , request send failed, Post \"https://api.ecr.eu-west-2.amazonaws.com/\": dial tcp 172.16.54.241:443: i/o timeout."
#             },
#             {
#                 "id": "27624bef-496e-4ad5-9840-c2561ec05c93",
#                 "createdAt": "2026-08-10T09:57:27.552000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 5ab0cf4d6a244e918ff5380e5c7f4a06)."
#             },
#             {
#                 "id": "3e16cf84-f107-4a22-98f0-9f943fd69ff9",
#                 "createdAt": "2026-08-10T09:56:57.277000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: The task cannot pull registry auth from Amazon ECR: There is a connection issue between the task and Amazon ECR. Check your task network configuration. operation error ECR: GetAuthorizationToken, exceeded maximum number of attempts, 3, https response error StatusCode: 0, RequestID: , request send failed, Post \"https://api.ecr.eu-west-2.amazonaws.com/\": dial tcp 172.16.54.241:443: i/o timeout."
#             },
#             {
#                 "id": "d777b3b4-d966-458b-b776-d1af48c459a1",
#                 "createdAt": "2026-08-10T09:52:09.328000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task b4a6e86fc58a40d6896f27bfef0cd003)."
#             },
#             {
#                 "id": "6fd309a6-75cf-4b5e-9415-6ddc05253079",
#                 "createdAt": "2026-08-10T09:51:27.988000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: The task cannot pull registry auth from Amazon ECR: There is a connection issue between the task and Amazon ECR. Check your task network configuration. operation erro
# r ECR: GetAuthorizationToken, exceeded maximum number of attempts, 3, https response error StatusCode: 0, RequestID: , request send failed, Post \"https://api.ecr.eu-west-2.amazonaws.com/\": dial tcp 172.16.54.241:443: i/o timeout."
#             },
#             {
#                 "id": "3e40a170-0a8e-4481-b153-8c81ad741f86",
#                 "createdAt": "2026-08-10T09:46:39.773000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task fe0bf0fc864f4cc984b24d52391a21c2)."
#             },
#             {
#                 "id": "60b89d4f-5a41-4414-b507-74a48445dfb7",
#                 "createdAt": "2026-08-10T07:46:50.315000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "82245134-985a-490f-9536-433dff9a9d5f",
#                 "createdAt": "2026-08-10T01:46:49.852000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "286a2c17-05c5-4a60-9ce7-3f427ca17bf8",
#                 "createdAt": "2026-08-09T19:46:48.069000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "b05520b6-81fe-4485-a251-7b14ee15e071",
#                 "createdAt": "2026-08-09T13:46:38.705000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "30c0a53f-b888-477d-bfc5-b6dadec122fd",
#                 "createdAt": "2026-08-09T07:45:59.879000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "084add5f-a157-4567-b952-06e5c4c00cd2",
#                 "createdAt": "2026-08-09T01:45:19.219000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "c16fc305-552c-49d7-b274-5678bb9761ba",
#                 "createdAt": "2026-08-08T21:44:33.681000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "1e7e98b0-b1cd-48c1-a623-decf8f5208c7",
#                 "createdAt": "2026-08-08T15:44:22.422000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "3e20d5a0-239c-48e9-b784-7781d99c474b",
#                 "createdAt": "2026-08-08T09:43:45.860000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "2349e168-f7e7-4a81-90c8-e03f4ccfb555",
#                 "createdAt": "2026-08-08T03:43:25.507000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "590bab01-a721-4481-b8b4b6f4-78b297dfc8f8",
#                 "createdAt": "2026-08-07T15:19:57.978000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "e9b9ada1-9ca3-4e9f-a353-ae6ddd915bb6",
#                 "createdAt": "2026-08-07T09:44:25.932000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "00b2fee3-cba5-48d5-82c9-239a112d5a90",
#                 "createdAt": "2026-08-07T03:44:25.871000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "c114a775-2dba-4daf-910f-843ac267cb57",
#                 "createdAt": "2026-08-06T21:44:05.776000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "21ed09cd-a25f-4f06-8a8a-21a091c54c18",
#                 "createdAt": "2026-08-06T15:43:31.885000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "af2d5fa3-62a4-4b9d-b75f-9f36b250dc6a",
#                 "createdAt": "2026-08-06T09:43:02.503000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "526f2893-b239-43b1-8d87-ab5b05425cb2",
#                 "createdAt": "2026-08-06T03:42:23.065000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "071d17f2-8e72-42b0-b3d2-30da1262f744",
#                 "createdAt": "2026-08-05T21:42:15.701000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "da46927b-0186-4e45-833e-d743d00b195d",
#                 "createdAt": "2026-08-05T15:41:49.036000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "98c9bba9-79ca-4c14-9f5b-ce94945aa002",
#                 "createdAt": "2026-08-05T09:41:48.014000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "5b963cd0-72a0-4431-9f28-b2407a50873e",
#                 "createdAt": "2026-08-05T03:41:34.506000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "3e6a5091-9a2d-4154-804b-4f84e68ad6d6",
#                 "createdAt": "2026-08-04T21:40:56.024000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "83cfba7b-d582-4443-9c04-14124285b692",
#                 "createdAt": "2026-08-04T15:40:32.229000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "1cd5c3a2-fe44-4da0-8ca4-3da147b3ad5c",
#                 "createdAt": "2026-08-04T09:40:15.351000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                     "id": "4fef90ae-9a90-45ff-a036-29aa5906174e",
#                 "createdAt": "2026-08-03T15:39:16.475000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "82f112f4-4cf7-404b-a5b4-a67c2d6309b3",
#                 "createdAt": "2026-08-03T15:18:06.974000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "c6bd3e08-5fb1-48f6-9ab8-0d6a9db3434a",
#                 "createdAt": "2026-08-03T13:32:00.126000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "7f3dab21-72d3-4620-b717-4ea513a4f3c6",
#                 "createdAt": "2026-08-03T07:31:51.934000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "55cabdbe-1c73-4071-bc63-b1d5bf9d9397",
#                 "createdAt": "2026-08-03T01:31:18.257000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "e9e40bd6-8c71-48c1-9e5d-d8c2d577a5af",
#                 "createdAt": "2026-08-02T19:31:04.042000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "e98a23e5-b851-40e6-8042-6ba5d8df2d48",
#                 "createdAt": "2026-08-02T13:30:38.361000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "2bad329a-3a0e-4d54-af1f-9fb108149510",
#                 "createdAt": "2026-08-02T07:30:08.810000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "2337b351-654f-458d-8399-6251b44c9e53",
#                 "createdAt": "2026-08-02T01:30:07.665000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "005cfc50-21f5-42bb-b2cd-2f5f32ae8842",
#                 "createdAt": "2026-08-01T19:29:45.337000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "29c9a3cd-dbd8-435a-a817-8a74be3febbb",
#                 "createdAt": "2026-08-01T13:29:21.941000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "5b60976f-cc60-4dff-ae1c-2611f6fe7677",
#                 "createdAt": "2026-08-01T07:29:06.573000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "1f32da9f-5af2-4a81-a061-a3490f7bceae",
#                 "createdAt": "2026-08-01T01:28:36.378000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "f477ea34-3939-4557-bb69-cd19a97e33c2",
#                 "createdAt": "2026-07-31T19:29:44.556000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "f230de13-e86f-423c-b3bc-3560968d8fea",
#                 "createdAt": "2026-07-31T19:29:44.555000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/5482803233485152419) deployment completed."
#             },
#             {
#                 "id": "e0139be3-29ea-4341-8128-68962346a6e7",
#                 "createdAt": "2026-07-31T19:28:42.581000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/4795384384208190029) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "65e17bdf-411e-40ec-9b00-f0927d194212",
#                 "createdAt": "2026-07-31T19:28:42.575000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "02f51a06-5ae2-46e4-91af-3b52b2ffa3cc",
#                 "createdAt": "2026-07-31T19:28:41.302000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task d3111b16c3c34e6ea5187f0fc98f2455)."
#             },
#             {
#                 "id": "ca4caad1-c21f-4bc2-b5b9-d07b2af0378f",
#                 "createdAt": "2026-07-31T19:28:22.149000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "c398620c-37f2-4c86-86e4-424075ccb032",
#                 "createdAt": "2026-07-31T19:28:00.668000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task ffac2619457e40de99133125870cd14b)."
#             },
#             {
#                 "id": "b37cdd6b-74e0-4954-9550-9072420e1f57",
#                 "createdAt": vb) (deployment ecs-svc/3762920399949102765) deployment completed."
#             },
#             {
#                 "id": "2268114a-d5ca-461b-b68d-bca890417da8",
#                 "createdAt": "2026-07-31T19:10:48.460000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/2085350554087678048) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "6a52d5b0-a54e-4a70-b029-5f0f378d8725",
#                 "createdAt": "2026-07-31T19:10:48.454000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "cd5465da-349e-4276-9c50-2061db7d3b76",
#                 "createdAt": "2026-07-31T19:10:38.193000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task 79d6a21fdf5b4b558eaa8f84097c9570)."
#             },
#             {
#                 "id": "df162135-e043-4618-8e58-56734b2c9f4c",
#                 "createdAt": "2026-07-31T19:10:18.168000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "bb1043a7-1901-41fe-a8ef-248f3e301a74",
#                 "createdAt": "2026-07-31T19:09:47.177000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 2d5a421e331e46a990d14b3238c80ec4)."
#             },
#             {
#                 "id": "337b26a4-46d2-4a32-ba0a-a9c6a26303c6",
#                 "createdAt": "2026-07-31T16:29:49.591000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "8caf954b-dc43-4407-9fc4-bbe9946def83",
#                 "createdAt": "2026-07-31T16:29:49.590000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/2085350554087678048) deployment completed."
#             },
#             {
#                 "id": "dc58ff72-d74b-45d0-a71d-e6a601d4dc0d",
#                 "createdAt": "2026-07-31T16:28:47.319000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/9906304779709753488) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "c6372118-7aa1-490e-9eba-0a41cca81c07",
#                 "createdAt": "2026-07-31T16:28:47.314000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "ff452ea9-e62b-4cef-a106-343fea5f3e91",
#                 "createdAt": "2026-07-31T16:28:37.421000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task 3e68de73fd52448782e77737f9ad255d)."
#             },
#             {
#                 "id": "b53eba5c-526d-4cbe-9104-b7f287e55a6f",
#                 "createdAt": "2026-07-31T16:28:17.251000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "92dcd794-69d2-4fa2-baaa-8591b3653611",
#                 "createdAt": "2026-07-31T16:27:56.183000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 79d6a21fdf5b4b558eaa8f84097c9570)."
#             },
#             {
#                 "id": "ff6fcecb-d692-4662-af98-ee7bd66afe3f",
#                 "createdAt": "2026-07-31T16:20:32.436000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "4d6833b6-a28a-44de-bfcc-192bea506ba9",
#                 "createdAt": "2026-07-31T16:20:32.435000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/9906304779709753488) deployment completed."
#             },
#             {
#                 "id": "2d66ae6c-11b5-4b55-a95e-0ae50df251f0",
#                 "createdAt": "2026-07-31T16:19:29.666000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/5397595424831880814) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "c4eb4759-12c5-47ec-8b73-6975b49e158f",
#                 "createdAt": "2026-07-31T16:19:29.659000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "500133e0-4fde-44de-a28c-c3ce74f2311a",
#                 "createdAt": "2026-07-31T16:19:20.268000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task 846fc500ed704e738db9e7bdc0578c6e)."
#             },
#             {
#                 "id": "e9938434-8704-476e-bc92-b371532e812c",
#                 "createdAt": "2026-07-31T16:19:00.296000+02:00",
#                 "message": "(see": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 846fc500ed704e738db9e7bdc0578c6e)."
#             },
#             {
#                 "id": "3ee5f7c8-27bc-4581-b28c-4ad0dad8b11b",
#                 "createdAt": "2026-07-31T16:05:13.732000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "3b127024-6f0d-4471-afee-9320decbc0a9",
#                 "createdAt": "2026-07-31T16:05:13.731000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/7772007978422758946) deployment completed."
#             },
#             {
#                 "id": "1e656f0f-7f16-458a-b031-d3910209eedb",
#                 "createdAt": "2026-07-31T16:04:12.376000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/1460255644178169698) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "26e93118-f329-4795-bf34-b9986e2a3c75",
#                 "createdAt": "2026-07-31T16:04:12.370000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "7b320abc-6f6f-40de-89e8-c98005b57ce5",
#                 "createdAt": "2026-07-31T16:04:02.478000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task 53c5f11da22e48d98e50d767a9e10246)."
#             }
#         ],
#         "createdAt": "2026-07-22T10:45:18.174000+02:00",
#         "placementConstraints": [],
#         "placementStrategy": [],
#         "networkConfiguration": {
#             "awsvpcConfiguration": {
#                 "subnets": [
#                     "subnet-0a36ff714c911de66",
#                     "subnet-0f1518686a5653072"
#                 ],
#                 "securityGroups": [
#                     "sg-091e067dceceafc4b"
#                 ],
#                 "assignPublicIp": "ENABLED"
#             }
#         },
#         "healthCheckGracePeriodSeconds": 30,
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


# ---------------------------------------------------------------------------
# STEP 7 (optional cleanup, after the new task is HEALTHY and stable)
# ---------------------------------------------------------------------------
#
# Remove the portal 3000/8443 ingress from the old fleetshell-task SG so it is
# purely the Valkey/MemoryDB SG going forward.  Leave the 6379 self-rule -- the
# MemoryDB node still needs it.  Do NOT delete sg-0709bc00b444b3a9a; MemoryDB is
# a member.  (Commands intentionally omitted until STEP 6 is verified.)

# ---------------------------------------------------------------------------
# STEP 8 -- Bring the remaining AWS services in-VPC (no public egress needed)
# ---------------------------------------------------------------------------
#
# ECR api/dkr already resolve to private endpoints and are allowed for the
# portal CIDRs (STEP 4).  But a Fargate task ALSO needs, at startup:
#   * Secrets Manager  -- the task def pulls 4 secrets (interface endpoint)
#   * CloudWatch Logs  -- awslogs driver ships stdout (interface endpoint)
#   * S3               -- ECR stores image LAYERS in S3 (gateway endpoint)
# Without these the failure just moves from ECR -> Secrets Manager -> logs/layers.
#
# With all three in place the portal starts with NO route to the IGW; the
# 0.0.0.0/0 -> IGW route becomes optional (only needed if the app itself makes
# outbound internet calls at runtime, e.g. future ACME).

SUBNET_PORTAL_A="subnet-0f1518686a5653072"   # FleetShell-portal-a (172.16.55.0/24, eu-west-2a)
SUBNET_PORTAL_B="subnet-0a36ff714c911de66"   # FleetShell-portal-b (172.16.56.0/24, eu-west-2b)
RTB_PORTAL="rtb-0d94176aa026639df"           # FleetShell-portal-rtb
S3_GW_ENDPOINT="vpce-0e96b7a35f98814ee"      # existing S3 gateway endpoint (add portal RTB to it)

# --- 8a: dedicated SG for the portal's interface endpoints (443 from portal) ---

# echo "# Create SG for portal interface endpoints"
# aws ec2 create-security-group \
#   --vpc-id "${VPC_ID}" \
#   --group-name FleetShell-portal-sg-endpoints \
#   --description "Portal interface endpoints: HTTPS from portal subnets" \
#   --tag-specifications 'ResourceType=security-group,Tags=[{Key=Name,Value=FleetShell-portal-sg-endpoints}]' \
#   --region "${REGION}"

# RESULT
# # Create SG for portal interface endpoints
# {
#     "GroupId": "sg-096b2f00f8de6901a",
#     "Tags": [
#         {
#             "Key": "Name",
#             "Value": "FleetShell-portal-sg-endpoints"
#         }
#     ]
# }

PORTAL_EP_SG="sg-096b2f00f8de6901a"   # <- fill from RESULT

# echo "# Allow HTTPS from portal subnets to the portal interface endpoints"
# aws ec2 authorize-security-group-ingress --group-id "${PORTAL_EP_SG}" \
#   --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":443,\"ToPort\":443,\"IpRanges\":[{\"CidrIp\":\"${PORTAL_CIDR_A}\",\"Description\":\"Portal-a\"},{\"CidrIp\":\"${PORTAL_CIDR_B}\",\"Description\":\"Portal-b\"}]}]" \
#   --region "${REGION}"

# RESULT
# # Allow HTTPS from portal subnets to the portal interface endpoints
# {
#     "Return": true,
#     "SecurityGroupRules": [
#         {
#             "SecurityGroupRuleId": "sgr-02b8a8bb194b92bdd",
#             "GroupId": "sg-096b2f00f8de6901a",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 443,
#             "ToPort": 443,
#             "CidrIpv4": "172.16.55.0/24",
#             "Description": "Portal-a"
#         },
#         {
#             "SecurityGroupRuleId": "sgr-0d955047a39f18026",
#             "GroupId": "sg-096b2f00f8de6901a",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 443,
#             "ToPort": 443,
#             "CidrIpv4": "172.16.56.0/24",
#             "Description": "Portal-b"
#         }
#     ]
# }


# --- 8b: Secrets Manager interface endpoint (private DNS) ---

# echo "# Secrets Manager interface endpoint"
# aws ec2 create-vpc-endpoint \
#   --vpc-id "${VPC_ID}" \
#   --vpc-endpoint-type Interface \
#   --service-name com.amazonaws.eu-west-2.secretsmanager \
#   --subnet-ids "${SUBNET_PORTAL_A}" "${SUBNET_PORTAL_B}" \
#   --security-group-ids "${PORTAL_EP_SG}" \
#   --private-dns-enabled \
#   --tag-specifications 'ResourceType=vpc-endpoint,Tags=[{Key=Name,Value=FleetShell-portal-secretsmanager}]' \
#   --region "${REGION}"

# RESULT
# # Secrets Manager interface endpoint
# {
#     "VpcEndpoint": {
#         "VpcEndpointId": "vpce-03e6db74421221a92",
#         "VpcEndpointType": "Interface",
#         "VpcId": "vpc-0595e17ce290fb050",
#         "ServiceName": "com.amazonaws.eu-west-2.secretsmanager",
#         "State": "pending",
#         "RouteTableIds": [],
#         "SubnetIds": [
#             "subnet-0a36ff714c911de66",
#             "subnet-0f1518686a5653072"
#         ],
#         "Groups": [
#             {
#                 "GroupId": "sg-096b2f00f8de6901a",
#                 "GroupName": "FleetShell-portal-sg-endpoints"
#             }
#         ],
#         "IpAddressType": "ipv4",
#         "DnsOptions": {
#             "DnsRecordIpType": "ipv4"
#         },
#         "PrivateDnsEnabled": true,
#         "RequesterManaged": false,
#         "NetworkInterfaceIds": [
#             "eni-0368599b4c2a85e1b",
#             "eni-0fc8537893f09fce9"
#         ],
#         "DnsEntries": [
#             {
#                 "DnsName": "vpce-03e6db74421221a92-gauzmqwt.secretsmanager.eu-west-2.vpce.amazonaws.com",
#                 "HostedZoneId": "Z7K1066E3PUKB"
#             },
#             {
#                 "DnsName": "vpce-03e6db74421221a92-gauzmqwt-eu-west-2a.secretsmanager.eu-west-2.vpce.amazonaws.com",
#                 "HostedZoneId": "Z7K1066E3PUKB"
#             },
#             {
#                 "DnsName": "vpce-03e6db74421221a92-gauzmqwt-eu-west-2b.secretsmanager.eu-west-2.vpce.amazonaws.com",
#                 "HostedZoneId": "Z7K1066E3PUKB"
#             },
#             {
#                 "DnsName": "secretsmanager.eu-west-2.amazonaws.com",
#                 "HostedZoneId": "ZONEIDPENDING"
#             }
#         ],
#         "CreationTimestamp": "2026-08-10T08:50:10.103000+00:00",
#         "Tags": [
#             {
#                 "Key": "Name",
#                 "Value": "FleetShell-portal-secretsmanager"
#             }
#         ],
#         "OwnerId": "295934382486"
#     }
# }

# --- 8c: CloudWatch Logs interface endpoint (private DNS) ---

# echo "# CloudWatch Logs interface endpoint"
# aws ec2 create-vpc-endpoint \
#   --vpc-id "${VPC_ID}" \
#   --vpc-endpoint-type Interface \
#   --service-name com.amazonaws.eu-west-2.logs \
#   --subnet-ids "${SUBNET_PORTAL_A}" "${SUBNET_PORTAL_B}" \
#   --security-group-ids "${PORTAL_EP_SG}" \
#   --private-dns-enabled \
#   --tag-specifications 'ResourceType=vpc-endpoint,Tags=[{Key=Name,Value=FleetShell-portal-logs}]' \
#   --region "${REGION}"

# RESULT
# # CloudWatch Logs interface endpoint
# {
#     "VpcEndpoint": {
#         "VpcEndpointId": "vpce-025bc49056238b40c",
#         "VpcEndpointType": "Interface",
#         "VpcId": "vpc-0595e17ce290fb050",
#         "ServiceName": "com.amazonaws.eu-west-2.logs",
#         "State": "pending",
#         "RouteTableIds": [],
#         "SubnetIds": [
#             "subnet-0a36ff714c911de66",
#             "subnet-0f1518686a5653072"
#         ],
#         "Groups": [
#             {
#                 "GroupId": "sg-096b2f00f8de6901a",
#                 "GroupName": "FleetShell-portal-sg-endpoints"
#             }
#         ],
#         "IpAddressType": "ipv4",
#         "DnsOptions": {
#             "DnsRecordIpType": "ipv4"
#         },
#         "PrivateDnsEnabled": true,
#         "RequesterManaged": false,
#         "NetworkInterfaceIds": [
#             "eni-0f7c417eede9b32b0",
#             "eni-00a92bb1a3fc38623"
#         ],
#         "DnsEntries": [
#             {
#                 "DnsName": "vpce-025bc49056238b40c-zidwu609.logs.eu-west-2.vpce.amazonaws.com",
#                 "HostedZoneId": "Z7K1066E3PUKB"
#             },
#             {
#                 "DnsName": "vpce-025bc49056238b40c-zidwu609-eu-west-2a.logs.eu-west-2.vpce.amazonaws.com",
#                 "HostedZoneId": "Z7K1066E3PUKB"
#             },
#             {
#                 "DnsName": "vpce-025bc49056238b40c-zidwu609-eu-west-2b.logs.eu-west-2.vpce.amazonaws.com",
#                 "HostedZoneId": "Z7K1066E3PUKB"
#             },
#             {
#                 "DnsName": "logs.eu-west-2.amazonaws.com",
#                 "HostedZoneId": "ZONEIDPENDING"
#             },
#             {
#                 "DnsName": "logs.eu-west-2.api.aws",
#                 "HostedZoneId": "ZONEIDPENDING"
#             },
#             {
#                 "DnsName": "streaming-logs.eu-west-2.api.aws",
#                 "HostedZoneId": "ZONEIDPENDING"
#             },
#             {
#                 "DnsName": "streaming-logs.eu-west-2.amazonaws.com",
#                 "HostedZoneId": "ZONEIDPENDING"
#             }
#         ],
#         "CreationTimestamp": "2026-08-10T08:51:00.586000+00:00",
#         "Tags": [
#             {
#                 "Key": "Name",
#                 "Value": "FleetShell-portal-logs"
#             }
#         ],
#         "OwnerId": "295934382486"
#     }
# }

# --- 8d: associate the portal RTB with the existing S3 gateway endpoint ---
#
# Gateway endpoints are route-based (no SG).  Adding the portal RTB installs the
# S3 prefix-list route so ECR image-layer pulls stay in-VPC.

# echo "# Add portal RTB to the S3 gateway endpoint"
# aws ec2 modify-vpc-endpoint \
#   --vpc-endpoint-id "${S3_GW_ENDPOINT}" \
#   --add-route-table-ids "${RTB_PORTAL}" \
#   --region "${REGION}"

# RESULT
# # Add portal RTB to the S3 gateway endpoint
# {
#     "Return": true
# }

# --- 8e: recycle the service so the new task uses the endpoints ---

# echo "# Force new deployment"
# aws ecs update-service \
#   --cluster aeroftp-cluster \
#   --service fleetshell-portal-service-v6kb01vb \
#   --force-new-deployment \
#   --region "${REGION}"

# RESULT
# # Force new deployment
# {
#     "service": {
#         "serviceArn": "arn:aws:ecs:eu-west-2:295934382486:service/aeroftp-cluster/fleetshell-portal-service-v6kb01vb",
#         "serviceName": "fleetshell-portal-service-v6kb01vb",
#         "clusterArn": "arn:aws:ecs:eu-west-2:295934382486:cluster/aeroftp-cluster",
#         "loadBalancers": [
#             {
#                 "targetGroupArn": "arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3",
#                 "containerName": "fleetshell-portal",
#                 "containerPort": 3000
#             }
#         ],
#         "serviceRegistries": [],
#         "status": "ACTIVE",
#         "desiredCount": 1,
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
#         "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:6",
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
#                 "id": "ecs-svc/0207268522327770203",
#                 "status": "PRIMARY",
#                 "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:6",
#                 "desiredCount": 0,
#                 "pendingCount": 0,
#                 "runningCount": 0,
#                 "failedTasks": 0,
#                 "createdAt": "2026-08-10T10:52:38.208000+02:00",
#                 "updatedAt": "2026-08-10T10:52:38.208000+02:00",
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
#                             "subnet-0a36ff714c911de66",
#                             "subnet-0f1518686a5653072"
#                         ],
#                         "securityGroups": [
#                             "sg-091e067dceceafc4b"
#                         ],
#                         "assignPublicIp": "ENABLED"
#                     }
#                 },
#                 "rolloutState": "IN_PROGRESS",
#                 "rolloutStateReason": "ECS deployment ecs-svc/0207268522327770203 in progress."
#             },
#             {
#                 "id": "ecs-svc/5482803233485152419",
#                 "status": "ACTIVE",
#                 "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:6",
#                 "desiredCount": 1,
#                 "pendingCount": 0,
#                 "runningCount": 1,
#                 "failedTasks": 0,
#                 "createdAt": "2026-07-31T19:27:41.829000+02:00",
#                 "updatedAt": "2026-08-10T10:35:10.228000+02:00",
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
#                             "subnet-0779b66ce8c3a599c"
#                         ],
#                         "securityGroups": [
#                             "sg-0709bc00b444b3a9a"
#                         ],
#                         "assignPublicIp": "ENABLED"
#                     }
#                 },
#                 "rolloutState": "COMPLETED",
#                 "rolloutStateReason": "ECS deployment ecs-svc/5482803233485152419 completed."
#             },
#             {
#                 "id": "ecs-svc/7579758338671357520",
#                 "status": "ACTIVE",
#                 "taskDefinition": "arn:aws:ecs:eu-west-2:295934382486:task-definition/fleetshell-portal:6",
#                 "desiredCount": 1,
#                 "pendingCount": 0,
#                 "runningCount": 0,
#                 "failedTasks": 2,
#                 "createdAt": "2026-08-10T10:34:40.763000+02:00",
#                 "updatedAt": "2026-08-10T10:35:08.035000+02:00",
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
#                             "subnet-0a36ff714c911de66",
#                             "subnet-0f1518686a5653072"
#                         ],
#                         "securityGroups": [
#                             "sg-091e067dceceafc4b"
#                         ],
#                         "assignPublicIp": "ENABLED"
#                     }
#                 },
#                 "rolloutState": "IN_PROGRESS",
#                 "rolloutStateReason": "ECS deployment ecs-svc/7579758338671357520 in progress."
#             }
#         ],
#         "roleArn": "arn:aws:iam::295934382486:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS",
#         "events": [
#             {
#                 "id": "5ed1f979-d28e-433b-a558-bd30bbe76fcf",
#                 "createdAt": "2026-08-10T10:49:07.736000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: unable to retrieve secret from asm: There is a connection issue between the task and AWS Secrets Manager. Check your task network configuration. failed to fetch secret arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/client-cert-Uhh4oy from secrets manager: operation error Secrets Manager: GetSecretValue, https response error StatusCode: 0, RequestID: , canceled, context deadline exceeded."
#             },
#             {
#                 "id": "741e3a8e-0a39-43eb-b84c-9c3325585242",
#                 "createdAt": "2026-08-10T10:44:51.981000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 56bab34227d6481991ca8c24df0d61f2)."
#             },
#             {
#                 "id": "2c2daced-2165-4381-b93c-03ff9735e437",
#                 "createdAt": "2026-08-10T10:44:20.376000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: unable to retrieve secret from asm: There is a connection issue between the task and AWS Secrets Manager. Check your task network configuration. failed to fetch secret arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/client-cert-Uhh4oy from secrets manager: operation error Secrets Manager: GetSecretValue, https response error StatusCode: 0, RequestID: , canceled, context deadline exceeded."
#             },
#             {
#                 "id": "55195ed3-7b34-4477-b6b5-e9b252e4a834",
#                 "createdAt": "2026-08-10T10:40:00.357000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task fa607e34d0a8440bbd6e22dfd6995dd2)."
#             },
#             {
#                 "id": "a37c17d1-3332-4ae3-99d3-660dec6c9d41",
#                 "createdAt": "2026-08-10T10:39:28.903000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: unable to retrieve secret from asm: There is a connection issue between the task and AWS Secrets Manager. Check your task network configuration. failed to fetch secre
# t arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/client-cert-Uhh4oy from secrets manager: operation error Secrets Manager: GetSecretValue, https response error StatusCode: 0, RequestID: , canceled, context deadline exceeded."
#             },
#             {
#                 "id": "e69c8981-8faf-43a3-bced-54339e4bfe05",
#                 "createdAt": "2026-08-10T10:35:11.006000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task e72e8c6dc48a4c5989513bc25f1d195c)."
#             },
#             {
#                 "id": "f5e8e795-9512-4523-8b83-04759fd3097a",
#                 "createdAt": "2026-08-10T10:35:00.146000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) stopped 1 pending tasks."
#             },
#             {
#                 "id": "e45ce64b-5325-4a6f-8e8b-458c248c8a10",
#                 "createdAt": "2026-08-10T10:31:03.368000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 225250281e014077951beb5825658d3d)."
#             },
#             {
#                 "id": "9d77aac5-7d14-47ae-a9af-8711c7f0b6a9",
#                 "createdAt": "2026-08-10T10:08:09.231000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "844a89d8-b845-4fe0-b17a-62990b4dc025",
#                 "createdAt": "2026-08-10T10:08:09.230000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/5482803233485152419) deployment completed."
#             },
#             {
#                 "id": "506b6071-117f-4f0a-8beb-615d95accca3",
#                 "createdAt": "2026-08-10T10:07:18.816000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) stopped 1 pending tasks."
#             },
#             {
#                 "id": "adf3a929-d40a-460a-9bc4-aa09070797d9",
#                 "createdAt": "2026-08-10T10:07:16.030000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) rolling back to deployment ecs-svc/5482803233485152419."
#             },
#             {
#                 "id": "01086b12-f92c-4deb-b86d-9c89168f499a",
#                 "createdAt": "2026-08-10T10:07:16.029000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/2905821670595576283) deployment failed: tasks failed to start."
#             },
#             {
#                 "id": "82812586-9de6-4aee-96e9-af65459a0df6",
#                 "createdAt": "2026-08-10T10:07:13.157000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task ec77ece6e6af44e6949fedeed09b8dfc)."
#             },
#             {
#                 "id": "138142d8-6ec9-45c6-a6c5-4200b1879f42",
#                 "createdAt": "2026-08-10T10:02:16.634000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: The task cannot pull registry auth from Amazon ECR:
#  There is a connection issue between the task and Amazon ECR. Check your task network configuration. operation error ECR: GetAuthorizationToken, exceeded maximum number of attempts, 3, https response error StatusCode: 0, RequestID: , request send failed, Post \"https://api.ecr.eu-west-2.amazonaws.com/\": dial tcp 172.16.54.241:443: i/o timeout."
#             },
#             {
#                 "id": "27624bef-496e-4ad5-9840-c2561ec05c93",
#                 "createdAt": "2026-08-10T09:57:27.552000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 5ab0cf4d6a244e918ff5380e5c7f4a06)."
#             },
#             {
#                 "id": "3e16cf84-f107-4a22-98f0-9f943fd69ff9",
#                 "createdAt": "2026-08-10T09:56:57.277000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: The task cannot pull registry auth from Amazon ECR: There is a connection issue between the task and Amazon ECR. Check your task network configuration. operation error ECR: GetAuthorizationToken, exceeded maximum number of attempts, 3, https response error StatusCode: 0, RequestID: , request send failed, Post \"https://api.ecr.eu-west-2.amazonaws.com/\": dial tcp 172.16.54.241:443: i/o timeout."
#             },
#             {
#                 "id": "d777b3b4-d966-458b-b776-d1af48c459a1",
#                 "createdAt": "2026-08-10T09:52:09.328000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task b4a6e86fc58a40d6896f27bfef0cd003)."
#             },
#             {
#                 "id": "6fd309a6-75cf-4b5e-9415-6ddc05253079",
#                 "createdAt": "2026-08-10T09:51:27.988000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) was unable to place a task. Reason: ResourceInitializationError: unable to pull secrets or registry auth: The task cannot pull registry auth from Amazon ECR: There is a connection issue between the task and Amazon ECR. Check your task network configuration. operation error ECR: GetAuthorizationToken, exceeded maximum number of attempts, 3, https response error StatusCode: 0, RequestID: , request send failed, Post \"https://api.ecr.eu-west-2.amazonaws.com/\": dial tcp 172.16.54.241:443: i/o timeout."
#             },
#             {
#                 "id": "3e40a170-0a8e-4481-b153-8c81ad741f86",
#                 "createdAt": "2026-08-10T09:46:39.773000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task fe0bf0fc864f4cc984b24d52391a21c2)."
#             },
#             {
#                 "id": "60b89d4f-5a41-4414-b507-74a48445dfb7",
#                 "createdAt": "2026-08-10T07:46:50.315000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "82245134-985a-490f-9536-433dff9a9d5f",
#                 "createdAt": "2026-08-10T01:46:49.852000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "286a2c17-05c5-4a60-9ce7-3f427ca17bf8",
#                 "createdAt": "2026-08-09T19:46:48.069000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "b05520b6-81fe-4485-a251-7b14ee15e071",
#                 "createdAt": "2026-08-09T13:46:38.705000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "30c0a53f-b888-477d-bfc5-b6dadec122fd",
#                 "createdAt": "2026-08-09T07:45:59.879000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "084add5f-a157-4567-b952-06e5c4c00cd2",
#                 "createdAt": "2026-08-09T01:45:19.219000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "c16fc305-552c-49d7-b274-5678bb9761ba",
#                 "createdAt": "2026-08-08T21:44:33.681000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "1e7e98b0-b1cd-48c1-a623-decf8f5208c7",
#                 "createdAt": "2026-08-08T15:44:22.422000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "3e20d5a0-239c-48e9-b784-7781d99c474b",
#                 "createdAt": "2026-08-08T09:43:45.860000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "2349e168-f7e7-4a81-90c8-e03f4ccfb555",
#                 "createdAt": "2026-08-08T03:43:25.507000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "590bab01-a721-4481-b8b4-9510f2a3b0ae",
#                 "createdAt": "2026-08-07T21:42:54.649000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "b29e9e8b-315f-4184-999d-b3cf96d37166",
#                 "createdAt": "2026-08-07T15:42:11.768000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "dfd4c104-f4e7-47a6-b6f4-78b297dfc8f8",
#                 "createdAt": "2026-08-07T15:19:57.978000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "e9b9ada1-9ca3-4e9f-a353-ae6ddd915bb6",
#                 "createdAt": "2026-08-07T09:44:25.932000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "00b2fee3-cba5-48d5-82c9-239a112d5a90",
#                 "createdAt": "2026-08-07T03:44:25.871000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "c114a775-2dba-4daf-910f-843ac267cb57",
#                 "createdAt": "2026-08-06T21:44:05.776000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "21ed09cd-a25f-4f06-8a8a-21a091c54c18",
#                 "createdAt": "2026-08-06T15:43:31.885000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "af2d5fa3-62a4-4b9d-b75f-9f36b250dc6a",
#                 "createdAt": "2026-08-06T09:43:02.503000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "526f2893-b239-43b1-8d87-ab5b05425cb2",
#                 "createdAt": "2026-08-06T03:42:23.065000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "071d17f2-8e72-42b0-b3d2-30da1262f744",
#                 "createdAt": "2026-08-05T21:42:15.701000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "da46927b-0186-4e45-833e-d743d00b195d",
#                 "createdAt": "2026-08-05T15:41:49.036000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "98c9bba9-79ca-4c14-9f5b-ce94945aa002",
#                 "createdAt": "2026-08-05T09:41:48.014000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "5b963cd0-72a0-4431-9f28-b2407a50873e",
#                 "createdAt": "2026-08-05T03:41:34.506000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "3e6a5091-9a2d-4154-804b-4f84e68ad6d6",
#                 "createdAt": "2026-08-04T21:40:56.024000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "83cfba7b-d582-4443-9c04-14124285b692",
#                 "createdAt": "2026-08-04T15:40:32.229000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "1cd5c3a2-fe44-4da0-8ca4-3da147b3ad5c",
#                 "createdAt": "2026-08-04T09:40:15.351000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "6b5da56c-4b12-4ec4-8237-c38b3475987a",
#                 "createdAt": "2026-08-04T03:39:46.547000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "801c1aef-05f8-4588-943b-9f7a6870ceb6",
#                 "createdAt": "2026-08-03T21:39:18.471000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "4fef90ae-9a90-45ff-a036-29aa5906174e",
#                 "createdAt": "2026-08-03T15:39:16.475000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "82f112f4-4cf7-404b-a5b4-a67c2d6309b3",
#                 "createdAt": "2026-08-03T15:18:06.974000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "c6bd3e08-5fb1-48f6-9ab8-0d6a9db3434a",
#                 "createdAt": "2026-08-03T13:32:00.126000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "7f3dab21-72d3-4620-b717-4ea513a4f3c6",
#                 "createdAt": "2026-08-03T07:31:51.934000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "55cabdbe-1c73-4071-bc63-b1d5bf9d9397",
#                 "createdAt": "2026-08-03T01:31:18.257000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "e9e40bd6-8c71-48c1-9e5d-d8c2d577a5af",
#                 "createdAt": "2026-08-02T19:31:04.042000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "e98a23e5-b851-40e6-8042-6ba5d8df2d48",
#                 "createdAt": "2026-08-02T13:30:38.361000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "2bad329a-3a0e-4d54-af1f-9fb108149510",
#                 "createdAt": "2026-08-02T07:30:08.810000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "2337b351-654f-458d-8399-6251b44c9e53",
#                 "createdAt": "2026-08-02T01:30:07.665000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "005cfc50-21f5-42bb-b2cd-2f5f32ae8842",
#                 "createdAt": "2026-08-01T19:29:45.337000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "29c9a3cd-dbd8-435a-a817-8a74be3febbb",
#                 "createdAt": "2026-08-01T13:29:21.941000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "5b60976f-cc60-4dff-ae1c-2611f6fe7677",
#                 "createdAt": "2026-08-01T07:29:06.573000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "1f32da9f-5af2-4a81-a061-a3490f7bceae",
#                 "createdAt": "2026-08-01T01:28:36.378000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "f477ea34-3939-4557-bb69-cd19a97e33c2",
#                 "createdAt": "2026-07-31T19:29:44.556000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "f230de13-e86f-423c-b3bc-3560968d8fea",
#                 "createdAt": "2026-07-31T19:29:44.555000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/5482803233485152419) deployment completed."
#             },
#             {
#                 "id": "e0139be3-29ea-4341-8128-68962346a6e7",
#                 "createdAt": "2026-07-31T19:28:42.581000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/4795384384208190029) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "65e17bdf-411e-40ec-9b00-f0927d194212",
#                 "createdAt": "2026-07-31T19:28:42.575000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "02f51a06-5ae2-46e4-91af-3b52b2ffa3cc",
#                 "createdAt": "2026-07-31T19:28:41.302000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task d3111b16c3c34e6ea5187f0fc98f2455)."
#             },
#             {
#                 "id": "ca4caad1-c21f-4bc2-b5b9-d07b2af0378f",
#                 "createdAt": "2026-07-31T19:28:22.149000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "c398620c-37f2-4c86-86e4-424075ccb032",
#                 "createdAt": "2026-07-31T19:28:00.668000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task ffac2619457e40de99133125870cd14b)."
#             },
#             {
#                 "id": "b37cdd6b-74e0-4954-9550-9072420e1f57",
#                 "createdAt": "2026-07-31T19:18:11.871000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "b6e20f3f-84de-41c2-a8e3-d90c68f854fd",
#                 "createdAt": "2026-07-31T19:18:11.870000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/4795384384208190029) deployment completed."
#             },
#             {
#                 "id": "06a5d66c-58ed-4c42-99fc-ec98acb1a171",
#                 "createdAt": "2026-07-31T19:17:09.892000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/3762920399949102765) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "16e8db97-0733-4473-8c8c-37e816c8ce81",
#                 "createdAt": "2026-07-31T19:17:09.872000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "795545e6-c947-44ee-9e99-6cc729ba2319",
#                 "createdAt": "2026-07-31T19:16:59.885000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task 2d5a421e331e46a990d14b3238c80ec4)."
#             },
#             {
#                 "id": "523195f0-0811-4ae6-83d9-1772298ad5d2",
#                 "createdAt": "2026-07-31T19:16:39.612000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "c0bba001-38b6-4b79-a636-46f86c970211",
#                 "createdAt": "2026-07-31T19:16:19.529000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task d3111b16c3c34e6ea5187f0fc98f2455)."
#             },
#             {
#                 "id": "f0d7867e-a760-4c79-9bdb-6ea3da2376f0",
#                 "createdAt": "2026-07-31T19:11:49.818000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "ebb31997-0756-4e20-881e-a453c9c2caca",
#                 "createdAt": "2026-07-31T19:11:49.817000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/3762920399949102765) deployment completed."
#             },
#             {
#                 "id": "2268114a-d5ca-461b-b68d-bca890417da8",
#                 "createdAt": "2026-07-31T19:10:48.460000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/2085350554087678048) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "6a52d5b0-a54e-4a70-b029-5f0f378d8725",
#                 "createdAt": "2026-07-31T19:10:48.454000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "cd5465da-349e-4276-9c50-2061db7d3b76",
#                 "createdAt": "2026-07-31T19:10:38.193000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task 79d6a21fdf5b4b558eaa8f84097c9570)."
#             },
#             {
#                 "id": "df162135-e043-4618-8e58-56734b2c9f4c",
#                 "createdAt": "2026-07-31T19:10:18.168000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "bb1043a7-1901-41fe-a8ef-248f3e301a74",
#                 "createdAt": "2026-07-31T19:09:47.177000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 2d5a421e331e46a990d14b3238c80ec4)."
#             },
#             {
#                 "id": "337b26a4-46d2-4a32-ba0a-a9c6a26303c6",
#                 "createdAt": "2026-07-31T16:29:49.591000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "8caf954b-dc43-4407-9fc4-bbe9946def83",
#                 "createdAt": "2026-07-31T16:29:49.590000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/2085350554087678048) deployment completed."
#             },
#             {
#                 "id": "dc58ff72-d74b-45d0-a71d-e6a601d4dc0d",
#                 "createdAt": "2026-07-31T16:28:47.319000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/9906304779709753488) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "c6372118-7aa1-490e-9eba-0a41cca81c07",
#                 "createdAt": "2026-07-31T16:28:47.314000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "ff452ea9-e62b-4cef-a106-343fea5f3e91",
#                 "createdAt": "2026-07-31T16:28:37.421000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task 3e68de73fd52448782e77737f9ad255d)."
#             },
#             {
#                 "id": "b53eba5c-526d-4cbe-9104-b7f287e55a6f",
#                 "createdAt": "2026-07-31T16:28:17.251000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "92dcd794-69d2-4fa2-baaa-8591b3653611",
#                 "createdAt": "2026-07-31T16:27:56.183000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 79d6a21fdf5b4b558eaa8f84097c9570)."
#             },
#             {
#                 "id": "ff6fcecb-d692-4662-af98-ee7bd66afe3f",
#                 "createdAt": "2026-07-31T16:20:32.436000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "4d6833b6-a28a-44de-bfcc-192bea506ba9",
#                 "createdAt": "2026-07-31T16:20:32.435000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/9906304779709753488) deployment completed."
#             },
#             {
#                 "id": "2d66ae6c-11b5-4b55-a95e-0ae50df251f0",
#                 "createdAt": "2026-07-31T16:19:29.666000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/5397595424831880814) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "c4eb4759-12c5-47ec-8b73-6975b49e158f",
#                 "createdAt": "2026-07-31T16:19:29.659000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "500133e0-4fde-44de-a28c-c3ce74f2311a",
#                 "createdAt": "2026-07-31T16:19:20.268000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has stopped 1 running tasks: (task 846fc500ed704e738db9e7bdc0578c6e)."
#             },
#             {
#                 "id": "e9938434-8704-476e-bc92-b371532e812c",
#                 "createdAt": "2026-07-31T16:19:00.296000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) registered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             },
#             {
#                 "id": "9a62e9c5-3168-4fab-a2fd-31efc36f5a81",
#                 "createdAt": "2026-07-31T16:18:38.995000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has started 1 tasks: (task 3e68de73fd52448782e77737f9ad255d)."
#             },
#             {
#                 "id": "eb10f202-95e1-4e1a-bb1a-fb534fca0eab",
#                 "createdAt": "2026-07-31T16:13:40.557000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) has reached a steady state."
#             },
#             {
#                 "id": "b15d9c6b-e901-4dbb-9ca7-7605175e33da",
#                 "createdAt": "2026-07-31T16:13:40.556000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) (deployment ecs-svc/5397595424831880814) deployment completed."
#             },
#             {
#                 "id": "fe8c6d48-7acf-411c-ba83-4802a978e838",
#                 "createdAt": "2026-07-31T16:12:47.188000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb, taskSet ecs-svc/7772007978422758946) has begun draining connections on 1 tasks."
#             },
#             {
#                 "id": "c9c93fa3-ee84-477b-8c03-7b1e7f1e3473",
#                 "createdAt": "2026-07-31T16:12:47.183000+02:00",
#                 "message": "(service fleetshell-portal-service-v6kb01vb) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:eu-west-2:295934382486:targetgroup/fleetshell-portal-tg/5c4259f3f2214de3)"
#             }
#         ],
#         "createdAt": "2026-07-22T10:45:18.174000+02:00",
#         "placementConstraints": [],
#         "placementStrategy": [],
#         "networkConfiguration": {
#             "awsvpcConfiguration": {
#                 "subnets": [
#                     "subnet-0a36ff714c911de66",
#                     "subnet-0f1518686a5653072"
#                 ],
#                 "securityGroups": [
#                     "sg-091e067dceceafc4b"
#                 ],
#                 "assignPublicIp": "ENABLED"
#             }
#         },
#         "healthCheckGracePeriodSeconds": 30,
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

# Verify: the new task should reach STOPPED->RUNNING with no
# ResourceInitializationError.  If it still fails, describe-tasks stoppedReason
# names the exact service (secretsmanager / logs / s3) whose endpoint or SG
# needs attention.
