#!/usr/bin/env bash
set -euo pipefail
#
# make_aurora_global.sh
#
# Stand up the GLOBAL data plane for FleetShell master-data management:
# an Aurora PostgreSQL *Global Database* whose primary regional cluster lives
# in eu-west-2.  This cluster holds the data that must be readable worldwide:
#
#     master data : device, gateway, product, customer, customer_site
#     authz model : privilege, role, grant, scope, scope_constraint, scope_ref
#     identity key: group_id  (the group EXISTS globally; its MEMBERS are
#                              regional, see make_aurora_local.sh)
#
# WHY AURORA GLOBAL DATABASE
# --------------------------
# Storage-level cross-region replication (sub-second lag), read-only secondary
# regions, and optional write-forwarding.  Today we create only the primary
# (eu-west-2).  A secondary region is added later with a single
# `create-db-cluster --global-cluster-identifier fleetshell-global` call in that
# region, so the topology is future-proof from day one.
#
# WHY SERVERLESS v2
# -----------------
# The catalog is read-mostly with spiky admin writes; Serverless v2 scales ACUs
# to load and keeps the test bill small (0.5 ACU floor).  db.serverless is
# confirmed orderable for aurora-postgresql 16.13 in eu-west-2.
#
# NETWORK MODEL
# -------------
# Two dedicated PRIVATE DB subnets (one per AZ) -- the DB needs no internet
# egress, so they use the VPC main route table (VPC-local only).  A dedicated
# DB security group allows 5432 only from the portal task SG.
#
# RUN ORDER: STEP 1 (subnets) -> STEP 2 (subnet group) -> STEP 3 (SG)
#            -> STEP 4 (global cluster) -> STEP 5 (primary cluster)
#            -> STEP 6 (writer instance).  Fill each RESULT before the next step
#            that consumes its IDs.

REGION="eu-west-2"
VPC_ID="vpc-0595e17ce290fb050"

# DB client that must reach 5432:
PORTAL_TASK_SG="sg-091e067dceceafc4b"   # FleetShell-portal-task

# New DB CIDRs (verified unused in vpc-0595e17ce290fb050):
DB_CIDR_A="172.16.57.0/24"              # eu-west-2a
DB_CIDR_B="172.16.58.0/24"              # eu-west-2b

# Naming:
GLOBAL_ID="fleetshell-global"           # the global cluster (region-spanning handle)
PRIMARY_CLUSTER_ID="fleetshell-global-euw2"
WRITER_INSTANCE_ID="fleetshell-global-euw2-1"
ENGINE="aurora-postgresql"
ENGINE_VERSION="16.13"
DB_NAME="fleetshell"
MASTER_USER="fsadmin"
# Aurora GLOBAL clusters do NOT support the managed (Secrets Manager) master
# password, so we supply one explicitly and store it ourselves (STEP 5-SECRET).
# Generate a strong one, e.g.:  MASTER_PW=$(openssl rand -base64 24 | tr -d '/+=')
MASTER_PW=""   # <- set before STEP 5 (do NOT commit a real value)

# ---------------------------------------------------------------------------
# STEP 1 -- Dedicated private DB subnets (one per AZ)
# ---------------------------------------------------------------------------

# echo "# DB subnet -- AZ-a (eu-west-2a)"
# aws ec2 create-subnet \
#   --vpc-id "${VPC_ID}" \
#   --cidr-block "${DB_CIDR_A}" \
#   --availability-zone eu-west-2a \
#   --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=FleetShell-db-a}]' \
#   --region "${REGION}"

# echo "# DB subnet -- AZ-b (eu-west-2b)"
# aws ec2 create-subnet \
#   --vpc-id "${VPC_ID}" \
#   --cidr-block "${DB_CIDR_B}" \
#   --availability-zone eu-west-2b \
#   --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=FleetShell-db-b}]' \
#   --region "${REGION}"

# RESULT
# # DB subnet -- AZ-a (eu-west-2a)
# {
#     "Subnet": {
#         "AvailabilityZone": "eu-west-2a",
#         "AvailabilityZoneId": "euw2-az2",
#         "AvailableIpAddressCount": 251,
#         "CidrBlock": "172.16.57.0/24",
#         "DefaultForAz": false,
#         "MapPublicIpOnLaunch": false,
#         "MapCustomerOwnedIpOnLaunch": false,
#         "State": "available",
#         "SubnetId": "subnet-0e451606d0b35d3d5",
#         "VpcId": "vpc-0595e17ce290fb050",
#         "OwnerId": "295934382486",
#         "AssignIpv6AddressOnCreation": false,
#         "Ipv6CidrBlockAssociationSet": [],
#         "Tags": [
#             {
#                 "Key": "Name",
#                 "Value": "FleetShell-db-a"
#             }
#         ],
#         "SubnetArn": "arn:aws:ec2:eu-west-2:295934382486:subnet/subnet-0e451606d0b35d3d5",
#         "EnableDns64": false,
#         "Ipv6Native": false,
#         "PrivateDnsNameOptionsOnLaunch": {
#             "HostnameType": "ip-name",
#             "EnableResourceNameDnsARecord": false,
#             "EnableResourceNameDnsAAAARecord": false
#         }
#     }
# }
# # DB subnet -- AZ-b (eu-west-2b)
# {
#     "Subnet": {
#         "AvailabilityZone": "eu-west-2b",
#         "AvailabilityZoneId": "euw2-az3",
#         "AvailableIpAddressCount": 251,
#         "CidrBlock": "172.16.58.0/24",
#         "DefaultForAz": false,
#         "MapPublicIpOnLaunch": false,
#         "MapCustomerOwnedIpOnLaunch": false,
#         "State": "available",
#         "SubnetId": "subnet-0b79a30f1d81b9141",
#         "VpcId": "vpc-0595e17ce290fb050",
#         "OwnerId": "295934382486",
#         "AssignIpv6AddressOnCreation": false,
#         "Ipv6CidrBlockAssociationSet": [],
#         "Tags": [
#             {
#                 "Key": "Name",
#                 "Value": "FleetShell-db-b"
#             }
#         ],
#         "SubnetArn": "arn:aws:ec2:eu-west-2:295934382486:subnet/subnet-0b79a30f1d81b9141",
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
SUBNET_DB_A="subnet-0e451606d0b35d3d5"   # <- fill from RESULT (eu-west-2a)
SUBNET_DB_B="subnet-0b79a30f1d81b9141"   # <- fill from RESULT (eu-west-2b)

# ---------------------------------------------------------------------------
# STEP 2 -- DB subnet group spanning both AZs
# ---------------------------------------------------------------------------

# echo "# Create DB subnet group fleetshell-db-subnets"
# aws rds create-db-subnet-group \
#   --db-subnet-group-name fleetshell-db-subnets \
#   --db-subnet-group-description "FleetShell Aurora DB subnets (a/b)" \
#   --subnet-ids "${SUBNET_DB_A}" "${SUBNET_DB_B}" \
#   --region "${REGION}"

# RESULT
# # Create DB subnet group fleetshell-db-subnets
# {
#     "DBSubnetGroup": {
#         "DBSubnetGroupName": "fleetshell-db-subnets",
#         "DBSubnetGroupDescription": "FleetShell Aurora DB subnets (a/b)",
#         "VpcId": "vpc-0595e17ce290fb050",
#         "SubnetGroupStatus": "Complete",
#         "Subnets": [
#             {
#                 "SubnetIdentifier": "subnet-0b79a30f1d81b9141",
#                 "SubnetAvailabilityZone": {
#                     "Name": "eu-west-2b"
#                 },
#                 "SubnetOutpost": {},
#                 "SubnetStatus": "Active"
#             },
#             {
#                 "SubnetIdentifier": "subnet-0e451606d0b35d3d5",
#                 "SubnetAvailabilityZone": {
#                     "Name": "eu-west-2a"
#                 },
#                 "SubnetOutpost": {},
#                 "SubnetStatus": "Active"
#             }
#         ],
#         "DBSubnetGroupArn": "arn:aws:rds:eu-west-2:295934382486:subgrp:fleetshell-db-subnets",
#         "SupportedNetworkTypes": [
#             "IPV4"
#         ]
#     }
# }


# ---------------------------------------------------------------------------
# STEP 3 -- Dedicated DB security group (5432 from the portal task SG)
# ---------------------------------------------------------------------------

# echo "# Create DB security group fleetshell-db-sg"
# aws ec2 create-security-group \
#   --group-name fleetshell-db-sg \
#   --description "FleetShell Aurora PostgreSQL access (5432)" \
#   --vpc-id "${VPC_ID}" \
#   --tag-specifications 'ResourceType=security-group,Tags=[{Key=Name,Value=fleetshell-db-sg}]' \
#   --region "${REGION}"

# RESULT
# # Create DB security group fleetshell-db-sg
# {
#     "GroupId": "sg-0cab189b921350efd",
#     "Tags": [
#         {
#             "Key": "Name",
#             "Value": "fleetshell-db-sg"
#         }
#     ]
# }


# Capture the GroupId printed above:
DB_SG="sg-0cab189b921350efd"   # <- fill from RESULT

# echo "# Allow 5432 from the portal task SG"
# aws ec2 authorize-security-group-ingress \
#   --group-id "${DB_SG}" \
#   --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":5432,\"ToPort\":5432,\"UserIdGroupPairs\":[{\"GroupId\":\"${PORTAL_TASK_SG}\",\"Description\":\"portal task to Aurora\"}]}]" \
#   --region "${REGION}"

# RESULT
# # Allow 5432 from the portal task SG
# {
#     "Return": true,
#     "SecurityGroupRules": [
#         {
#             "SecurityGroupRuleId": "sgr-05944156ba062f4b8",
#             "GroupId": "sg-0cab189b921350efd",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 5432,
#             "ToPort": 5432,
#             "ReferencedGroupInfo": {
#                 "GroupId": "sg-091e067dceceafc4b",
#                 "UserId": "295934382486"
#             },
#             "Description": "portal task to Aurora"
#         }
#     ]
# }


# ---------------------------------------------------------------------------
# STEP 4 -- Create the (empty) GLOBAL cluster
# ---------------------------------------------------------------------------
#
# The global cluster is a region-spanning handle; the actual storage is created
# with the primary regional cluster in STEP 5.

# echo "# Create global cluster ${GLOBAL_ID}"
# aws rds create-global-cluster \
#   --global-cluster-identifier "${GLOBAL_ID}" \
#   --engine "${ENGINE}" \
#   --engine-version "${ENGINE_VERSION}" \
#   --region "${REGION}"

# RESULT
# # Create global cluster fleetshell-global
# {
#     "GlobalCluster": {
#         "GlobalClusterIdentifier": "fleetshell-global",
#         "GlobalClusterResourceId": "cluster-9555939b66951c63",
#         "GlobalClusterArn": "arn:aws:rds::295934382486:global-cluster:fleetshell-global",
#         "Status": "available",
#         "Engine": "aurora-postgresql",
#         "EngineVersion": "16.13",
#         "StorageEncrypted": false,
#         "DeletionProtection": false,
#         "GlobalClusterMembers": []
#     }
# }


# ---------------------------------------------------------------------------
# STEP 4-FIX -- Recreate the global cluster ENCRYPTED (it came back unencrypted)
# ---------------------------------------------------------------------------
#
# An empty global cluster created without --storage-encrypted defaults to
# StorageEncrypted=false, and the primary cluster's setting must MATCH. Enable
# encryption now while the global cluster is still empty (GlobalClusterMembers:
# []) -- it cannot be toggled on an existing cluster later without a
# snapshot/restore. Uses the default aws/rds KMS key.

# echo "# Delete the unencrypted (empty) global cluster"
# aws rds delete-global-cluster \
#   --global-cluster-identifier "${GLOBAL_ID}" \
#   --region "${REGION}"

# RESULT
# # Delete the unencrypted (empty) global cluster
# {
#     "GlobalCluster": {
#         "GlobalClusterIdentifier": "fleetshell-global",
#         "GlobalClusterResourceId": "cluster-9555939b66951c63",
#         "GlobalClusterArn": "arn:aws:rds::295934382486:global-cluster:fleetshell-global",
#         "Status": "available",
#         "Engine": "aurora-postgresql",
#         "EngineVersion": "16.13",
#         "StorageEncrypted": false,
#         "DeletionProtection": false,
#         "GlobalClusterMembers": []
#     }
# }

# echo "# Recreate the global cluster WITH storage encryption"
# aws rds create-global-cluster \
#   --global-cluster-identifier "${GLOBAL_ID}" \
#   --engine "${ENGINE}" \
#   --engine-version "${ENGINE_VERSION}" \
#   --storage-encrypted \
#   --region "${REGION}"

# RESULT
# # Recreate the global cluster WITH storage encryption
# {
#     "GlobalCluster": {
#         "GlobalClusterIdentifier": "fleetshell-global",
#         "GlobalClusterResourceId": "cluster-647c2df8040964c4",
#         "GlobalClusterArn": "arn:aws:rds::295934382486:global-cluster:fleetshell-global",
#         "Status": "available",
#         "Engine": "aurora-postgresql",
#         "EngineVersion": "16.13",
#         "StorageEncrypted": true,
#         "DeletionProtection": false,
#         "GlobalClusterMembers": []
#     }
# }

# ---------------------------------------------------------------------------
# STEP 5 -- Create the PRIMARY regional cluster, joined to the global cluster
# ---------------------------------------------------------------------------
#
# --master-user-password: Aurora GLOBAL clusters do NOT support the managed
# (Secrets Manager) master password on create OR modify -- supply it explicitly
# and store it in Secrets Manager ourselves (STEP 5-SECRET below).
# --storage-encrypted must MATCH the global cluster (now encrypted, see 4-FIX).

# echo "# Create primary cluster ${PRIMARY_CLUSTER_ID}"
# aws rds create-db-cluster \
#   --db-cluster-identifier "${PRIMARY_CLUSTER_ID}" \
#   --global-cluster-identifier "${GLOBAL_ID}" \
#   --engine "${ENGINE}" \
#   --engine-version "${ENGINE_VERSION}" \
#   --database-name "${DB_NAME}" \
#   --master-username "${MASTER_USER}" \
#   --master-user-password "${MASTER_PW}" \
#   --storage-encrypted \
#   --db-subnet-group-name fleetshell-db-subnets \
#   --vpc-security-group-ids "${DB_SG}" \
#   --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=8 \
#   --backup-retention-period 7 \
#   --region "${REGION}"

# RESULT
# # Create primary cluster fleetshell-global-euw2
# {
#     "DBCluster": {
#         "AllocatedStorage": 1,
#         "AvailabilityZones": [
#             "eu-west-2a",
#             "eu-west-2b",
#             "eu-west-2c"
#         ],
#         "BackupRetentionPeriod": 7,
#         "DatabaseName": "fleetshell",
#         "DBClusterIdentifier": "fleetshell-global-euw2",
#         "DBClusterParameterGroup": "default.aurora-postgresql16",
#         "DBSubnetGroup": "fleetshell-db-subnets",
#         "Status": "creating",
#         "Endpoint": "fleetshell-global-euw2.cluster-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#         "ReaderEndpoint": "fleetshell-global-euw2.cluster-ro-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#         "MultiAZ": false,
#         "Engine": "aurora-postgresql",
#         "EngineVersion": "16.13",
#         "Port": 5432,
#         "MasterUsername": "fsadmin",
#         "PreferredBackupWindow": "02:31-03:01",
#         "PreferredMaintenanceWindow": "thu:23:44-fri:00:14",
#         "ReadReplicaIdentifiers": [],
#         "DBClusterMembers": [],
#         "VpcSecurityGroups": [
#             {
#                 "VpcSecurityGroupId": "sg-0cab189b921350efd",
#                 "Status": "active"
#             }
#         ],
#         "HostedZoneId": "Z1TTGA775OQIYO",
#         "StorageEncrypted": true,
#         "KmsKeyId": "arn:aws:kms:eu-west-2:295934382486:key/97a3d904-9e94-46ec-9612-1d67acad0711",
#         "DbClusterResourceId": "cluster-ZSOVHRGNL7D7JWLHWWCIBKWL4A",
#         "DBClusterArn": "arn:aws:rds:eu-west-2:295934382486:cluster:fleetshell-global-euw2",
#         "AssociatedRoles": [],
#         "IAMDatabaseAuthenticationEnabled": false,
#         "ClusterCreateTime": "2026-08-12T16:05:35.042000+00:00",
#         "EngineMode": "provisioned",
#         "DeletionProtection": false,
#         "HttpEndpointEnabled": false,
#         "CopyTagsToSnapshot": false,
#         "CrossAccountClone": false,
#         "DomainMemberships": [],
#         "TagList": [],
#         "GlobalWriteForwardingRequested": false,
#         "AutoMinorVersionUpgrade": true,
#         "ServerlessV2ScalingConfiguration": {
#             "MinCapacity": 0.5,
#             "MaxCapacity": 8.0
#         },
#         "NetworkType": "IPV4",
#         "LocalWriteForwardingStatus": "disabled"
#     }
# }


# Capture the cluster writer endpoint from RESULT:
GLOBAL_WRITER_ENDPOINT="fleetshell-global-euw2.cluster-cpgmocimewi5.eu-west-2.rds.amazonaws.com"   # <- fill from RESULT (.Endpoint)

# ---------------------------------------------------------------------------
# STEP 5-SECRET -- Store the master credentials in Secrets Manager ourselves
# ---------------------------------------------------------------------------
#
# Global clusters can't have RDS manage this. The username/password keys are
# exactly what RDS Proxy (STEP 9) expects; host/port/dbname let the portal read
# one self-contained connection secret. Fill GLOBAL_WRITER_ENDPOINT first.

# echo "# Create master credential secret"
# aws secretsmanager create-secret \
#   --name fleetshell/global/master \
#   --description "FleetShell global Aurora master credentials" \
#   --secret-string "{\"username\":\"${MASTER_USER}\",\"password\":\"${MASTER_PW}\",\"engine\":\"postgres\",\"host\":\"${GLOBAL_WRITER_ENDPOINT}\",\"port\":5432,\"dbname\":\"${DB_NAME}\"}" \
#   --region "${REGION}"

# RESULT
# # Create master credential secret
# {
#     "ARN": "arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/global/master-x3Pexj",
#     "Name": "fleetshell/global/master",
#     "VersionId": "835e7cd7-68e8-4226-ba3b-42f07b08ef7c"
# }


# Capture the secret ARN from RESULT (portal DB creds + RDS Proxy STEP 9):
GLOBAL_MASTER_SECRET_ARN="arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/global/master-x3Pexj" # <- fill from RESULT (.ARN)

# ---------------------------------------------------------------------------
# STEP 6 -- Create the Serverless v2 writer instance
# ---------------------------------------------------------------------------

# echo "# Create writer instance ${WRITER_INSTANCE_ID}"
# aws rds create-db-instance \
#   --db-instance-identifier "${WRITER_INSTANCE_ID}" \
#   --db-cluster-identifier "${PRIMARY_CLUSTER_ID}" \
#   --engine "${ENGINE}" \
#   --db-instance-class db.serverless \
#   --region "${REGION}"

# RESULT
# # Create writer instance fleetshell-global-euw2-1
# {
#     "DBInstance": {
#         "DBInstanceIdentifier": "fleetshell-global-euw2-1",
#         "DBInstanceClass": "db.serverless",
#         "Engine": "aurora-postgresql",
#         "DBInstanceStatus": "creating",
#         "MasterUsername": "fsadmin",
#         "DBName": "fleetshell",
#         "AllocatedStorage": 1,
#         "PreferredBackupWindow": "02:31-03:01",
#         "BackupRetentionPeriod": 7,
#         "DBSecurityGroups": [],
#         "VpcSecurityGroups": [
#             {
#                 "VpcSecurityGroupId": "sg-0cab189b921350efd",
#                 "Status": "active"
#             }
#         ],
#         "DBParameterGroups": [
#             {
#                 "DBParameterGroupName": "default.aurora-postgresql16",
#                 "ParameterApplyStatus": "in-sync"
#             }
#         ],
#         "DBSubnetGroup": {
#             "DBSubnetGroupName": "fleetshell-db-subnets",
#             "DBSubnetGroupDescription": "FleetShell Aurora DB subnets (a/b)",
#             "VpcId": "vpc-0595e17ce290fb050",
#             "SubnetGroupStatus": "Complete",
#             "Subnets": [
#                 {
#                     "SubnetIdentifier": "subnet-0b79a30f1d81b9141",
#                     "SubnetAvailabilityZone": {
#                         "Name": "eu-west-2b"
#                     },
#                     "SubnetOutpost": {},
#                     "SubnetStatus": "Active"
#                 },
#                 {
#                     "SubnetIdentifier": "subnet-0e451606d0b35d3d5",
#                     "SubnetAvailabilityZone": {
#                         "Name": "eu-west-2a"
#                     },
#                     "SubnetOutpost": {},
#                     "SubnetStatus": "Active"
#                 }
#             ]
#         },
#         "PreferredMaintenanceWindow": "thu:04:48-thu:05:18",
#         "PendingModifiedValues": {},
#         "MultiAZ": false,
#         "EngineVersion": "16.13",
#         "AutoMinorVersionUpgrade": true,
#         "ReadReplicaDBInstanceIdentifiers": [],
#         "LicenseModel": "postgresql-license",
#         "OptionGroupMemberships": [
#             {
#                 "OptionGroupName": "default:aurora-postgresql-16",
#                 "Status": "in-sync"
#             }
#         ],
#         "PubliclyAccessible": false,
#         "StorageType": "aurora",
#         "DbInstancePort": 0,
#         "DBClusterIdentifier": "fleetshell-global-euw2",
#         "StorageEncrypted": true,
#         "KmsKeyId": "arn:aws:kms:eu-west-2:295934382486:key/97a3d904-9e94-46ec-9612-1d67acad0711",
#         "DbiResourceId": "db-REX34MW73E3PCOMEAR4XYBBUYM",
#         "CACertificateIdentifier": "rds-ca-rsa2048-g1",
#         "DomainMemberships": [],
#         "CopyTagsToSnapshot": false,
#         "MonitoringInterval": 0,
#         "PromotionTier": 1,
#         "DBInstanceArn": "arn:aws:rds:eu-west-2:295934382486:db:fleetshell-global-euw2-1",
#         "IAMDatabaseAuthenticationEnabled": false,
#         "PerformanceInsightsEnabled": false,
#         "DeletionProtection": false,
#         "AssociatedRoles": [],
#         "TagList": [],
#         "CustomerOwnedIpEnabled": false,
#         "BackupTarget": "region",
#         "NetworkType": "IPV4",
#         "StorageThroughput": 0,
#         "CertificateDetails": {
#             "CAIdentifier": "rds-ca-rsa2048-g1"
#         },
#         "DedicatedLogVolume": false
#     }
# }


# ---------------------------------------------------------------------------
# STEP 7 -- Wait until available, then confirm the endpoint
# ---------------------------------------------------------------------------

# echo "# Wait for the writer instance to become available"
# aws rds wait db-instance-available \
#   --db-instance-identifier "${WRITER_INSTANCE_ID}" \
#   --region "${REGION}"

# echo "# Show cluster endpoints"
# aws rds describe-db-clusters \
#   --db-cluster-identifier "${PRIMARY_CLUSTER_ID}" \
#   --query 'DBClusters[0].{Writer:Endpoint,Reader:ReaderEndpoint,Status:Status,Secret:MasterUserSecret.SecretArn}' \
#   --region "${REGION}"

# RESULT
# # Wait for the writer instance to become available
# # Show cluster endpoints
# {
#     "Writer": "fleetshell-global-euw2.cluster-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#     "Reader": "fleetshell-global-euw2.cluster-ro-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#     "Status": "available",
#     "Secret": null
# }


# ---------------------------------------------------------------------------
# STEP 8 (recommended) -- Add a Serverless v2 READER instance
# ---------------------------------------------------------------------------
#
# The portal routes "list devices I can access" (a READ) to the cluster READER
# endpoint. With only the writer present the reader endpoint targets the writer;
# a second instance gives real read scaling for the list-query burst (see
# docs/authz_caching.md). It also becomes the fast failover target.

# echo "# Create reader instance fleetshell-global-euw2-2"
# aws rds create-db-instance \
#   --db-instance-identifier fleetshell-global-euw2-2 \
#   --db-cluster-identifier "${PRIMARY_CLUSTER_ID}" \
#   --engine "${ENGINE}" \
#   --db-instance-class db.serverless \
#   --region "${REGION}"

# RESULT
# # Create reader instance fleetshell-global-euw2-2
# {
#     "DBInstance": {
#         "DBInstanceIdentifier": "fleetshell-global-euw2-2",
#         "DBInstanceClass": "db.serverless",
#         "Engine": "aurora-postgresql",
#         "DBInstanceStatus": "creating",
#         "MasterUsername": "fsadmin",
#         "DBName": "fleetshell",
#         "AllocatedStorage": 1,
#         "PreferredBackupWindow": "02:31-03:01",
#         "BackupRetentionPeriod": 7,
#         "DBSecurityGroups": [],
#         "VpcSecurityGroups": [
#             {
#                 "VpcSecurityGroupId": "sg-0cab189b921350efd",
#                 "Status": "active"
#             }
#         ],
#         "DBParameterGroups": [
#             {
#                 "DBParameterGroupName": "default.aurora-postgresql16",
#                 "ParameterApplyStatus": "in-sync"
#             }
#         ],
#         "DBSubnetGroup": {
#             "DBSubnetGroupName": "fleetshell-db-subnets",
#             "DBSubnetGroupDescription": "FleetShell Aurora DB subnets (a/b)",
#             "VpcId": "vpc-0595e17ce290fb050",
#             "SubnetGroupStatus": "Complete",
#             "Subnets": [
#                 {
#                     "SubnetIdentifier": "subnet-0b79a30f1d81b9141",
#                     "SubnetAvailabilityZone": {
#                         "Name": "eu-west-2b"
#                     },
#                     "SubnetOutpost": {},
#                     "SubnetStatus": "Active"
#                 },
#                 {
#                     "SubnetIdentifier": "subnet-0e451606d0b35d3d5",
#                     "SubnetAvailabilityZone": {
#                         "Name": "eu-west-2a"
#                     },
#                     "SubnetOutpost": {},
#                     "SubnetStatus": "Active"
#                 }
#             ]
#         },
#         "PreferredMaintenanceWindow": "mon:03:17-mon:03:47",
#         "PendingModifiedValues": {},
#         "MultiAZ": false,
#         "EngineVersion": "16.13",
#         "AutoMinorVersionUpgrade": true,
#         "ReadReplicaDBInstanceIdentifiers": [],
#         "LicenseModel": "postgresql-license",
#         "OptionGroupMemberships": [
#             {
#                 "OptionGroupName": "default:aurora-postgresql-16",
#                 "Status": "in-sync"
#             }
#         ],
#         "PubliclyAccessible": false,
#         "StorageType": "aurora",
#         "DbInstancePort": 0,
#         "DBClusterIdentifier": "fleetshell-global-euw2",
#         "StorageEncrypted": true,
#         "KmsKeyId": "arn:aws:kms:eu-west-2:295934382486:key/97a3d904-9e94-46ec-9612-1d67acad0711",
#         "DbiResourceId": "db-MSHFTKG24IQCPQEA32WVB4TNUY",
#         "CACertificateIdentifier": "rds-ca-rsa2048-g1",
#         "DomainMemberships": [],
#         "CopyTagsToSnapshot": false,
#         "MonitoringInterval": 0,
#         "PromotionTier": 1,
#         "DBInstanceArn": "arn:aws:rds:eu-west-2:295934382486:db:fleetshell-global-euw2-2",
#         "IAMDatabaseAuthenticationEnabled": false,
#         "PerformanceInsightsEnabled": false,
#         "DeletionProtection": false,
#         "AssociatedRoles": [],
#         "TagList": [],
#         "CustomerOwnedIpEnabled": false,
#         "BackupTarget": "region",
#         "NetworkType": "IPV4",
#         "StorageThroughput": 0,
#         "CertificateDetails": {
#             "CAIdentifier": "rds-ca-rsa2048-g1"
#         },
#         "DedicatedLogVolume": false
#     }
# }


# ---------------------------------------------------------------------------
# STEP 9 (recommended) -- RDS Proxy in front for CONNECTION POOLING
# ---------------------------------------------------------------------------
#
# WHY: 500-1000 portal sessions would exhaust raw Postgres connections. RDS
# Proxy multiplexes many client connections onto a small backend pool and
# survives Serverless v2 scaling events. The portal connects to the PROXY
# endpoint, not the cluster endpoint.
#
# PREREQUISITE (one-time IAM): an IAM role the proxy assumes to read the master
# secret from Secrets Manager. Create it and note its ARN as PROXY_ROLE_ARN:
#
#   aws iam create-role --role-name fleetshell-rdsproxy \
#     --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"rds.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
#
#   # Inline policies are denied in this account (SCP/boundary), so ATTACH an AWS
#   # managed policy instead. SecretsManagerReadWrite includes GetSecretValue,
#   # and the default aws/secretsmanager KMS key needs no extra KMS permission:
# aws iam attach-role-policy --role-name fleetshell-rdsproxy \
#   --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite
#
#   # NOTE: SecretsManagerReadWrite is broader than one secret (secretsmanager:*
#   # on all secrets). If least-privilege is required and inline policies stay
#   # blocked, either (a) have an admin create a scoped customer-managed policy
#   # to attach, or (b) skip RDS Proxy and pool with a PgBouncer sidecar in the
#   # portal task (transaction mode) -- no IAM role needed at all.

# RESULT
# {
#     "Role": {
#         "Path": "/",
#         "RoleName": "fleetshell-rdsproxy",
#         "RoleId": "AROAUJZYQKGLMNG6K6QTU",
#         "Arn": "arn:aws:iam::295934382486:role/fleetshell-rdsproxy",
#         "CreateDate": "2026-08-12T16:24:22+00:00",
#         "AssumeRolePolicyDocument": {
#             "Version": "2012-10-17",
#             "Statement": [
#                 {
#                     "Effect": "Allow",
#                     "Principal": {
#                         "Service": "rds.amazonaws.com"
#                     },
#                     "Action": "sts:AssumeRole"
#                 }
#             ]
#         }
#     }
# }

# An error occurred (AccessDenied) when calling the PutRolePolicy operation: User: arn:aws:sts::295934382486:assumed-role/AWSReservedSSO_CLI-Role-PowerUserAndVPC_3a45f6c9035e1a71/michael.rommel@siemens-healthineers.com is not authorized to perform: iam:PutRolePolicy on resource: role fleetshell-rdsproxy with an explicit deny in an identity-based policy

PROXY_ROLE_ARN="arn:aws:iam::295934382486:role/fleetshell-rdsproxy"   # <- fill from the create-role RESULT (.Role.Arn)

# echo "# Create RDS Proxy fleetshell-global-proxy"
# aws rds create-db-proxy \
#   --db-proxy-name fleetshell-global-proxy \
#   --engine-family POSTGRESQL \
#   --auth "AuthScheme=SECRETS,SecretArn=${GLOBAL_MASTER_SECRET_ARN},IAMAuth=DISABLED" \
#   --role-arn "${PROXY_ROLE_ARN}" \
#   --vpc-subnet-ids "${SUBNET_DB_A}" "${SUBNET_DB_B}" \
#   --vpc-security-group-ids "${DB_SG}" \
#   --require-tls \
#   --region "${REGION}"

# RESULT
# # Create RDS Proxy fleetshell-global-proxy
# {
#     "DBProxy": {
#         "DBProxyName": "fleetshell-global-proxy",
#         "DBProxyArn": "arn:aws:rds:eu-west-2:295934382486:db-proxy:prx-065a0185e23faa6fb",
#         "Status": "creating",
#         "EngineFamily": "POSTGRESQL",
#         "VpcId": "vpc-0595e17ce290fb050",
#         "VpcSecurityGroupIds": [
#             "sg-0cab189b921350efd"
#         ],
#         "VpcSubnetIds": [
#             "subnet-0e451606d0b35d3d5",
#             "subnet-0b79a30f1d81b9141"
#         ],
#         "Auth": [
#             {
#                 "AuthScheme": "SECRETS",
#                 "SecretArn": "arn:aws:secretsmanager:eu-west-2:295934382486:secret:fleetshell/global/master-x3Pexj",
#                 "IAMAuth": "DISABLED",
#                 "ClientPasswordAuthType": "POSTGRES_SCRAM_SHA_256"
#             }
#         ],
#         "RoleArn": "arn:aws:iam::295934382486:role/fleetshell-rdsproxy",
#         "Endpoint": "fleetshell-global-proxy.proxy-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#         "RequireTLS": true,
#         "IdleClientTimeout": 1800,
#         "DebugLogging": false,
#         "CreatedDate": "2026-08-12T16:40:11.881000+00:00"
#     }
# }


# echo "# Point the proxy at the primary cluster"
# aws rds register-db-proxy-targets \
#   --db-proxy-name fleetshell-global-proxy \
#   --db-cluster-identifiers "${PRIMARY_CLUSTER_ID}" \
#   --region "${REGION}"

# RESULT
# # Point the proxy at the primary cluster
# {
#     "DBProxyTargets": [
#         {
#             "RdsResourceId": "fleetshell-global-euw2",
#             "Port": 5432,
#             "Type": "TRACKED_CLUSTER",
#             "TargetHealth": {
#                 "State": "REGISTERING"
#             }
#         },
#         {
#             "Endpoint": "fleetshell-global-euw2-1.cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#             "RdsResourceId": "fleetshell-global-euw2-1",
#             "Port": 5432,
#             "Type": "RDS_INSTANCE",
#             "TargetHealth": {
#                 "State": "REGISTERING"
#             }
#         },
#         {
#             "Endpoint": "fleetshell-global-euw2-2.cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#             "RdsResourceId": "fleetshell-global-euw2-2",
#             "Port": 5432,
#             "Type": "RDS_INSTANCE",
#             "TargetHealth": {
#                 "State": "REGISTERING"
#             }
#         }
#     ]
# }


# echo "# Show the proxy endpoint the portal should use"
# aws rds describe-db-proxies \
#   --db-proxy-name fleetshell-global-proxy \
#   --query 'DBProxies[0].{Endpoint:Endpoint,Status:Status}' \
#   --region "${REGION}"

# RESULT
# # Show the proxy endpoint the portal should use
# {
#     "Endpoint": "fleetshell-global-proxy.proxy-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#     "Status": "creating"
# }


# ---------------------------------------------------------------------------
# STEP 10 (admin) -- Allow the aerocli bastion to reach Aurora (schema apply)
# ---------------------------------------------------------------------------
#
# The DB subnets are private and fleetshell-db-sg only admits the portal task
# SG, so schema/DDL is applied from the aerocli bastion (i-01a9bfe89868566ea,
# reachable via SSM/SSH). aerocli carries CLI_RemoteAccess (sg-011b3ebfcfbcca22d);
# reference that SG (survives instance stop/start) on 5432. This one rule covers
# BOTH clusters -- global and local share fleetshell-db-sg.
#
# Apply workflow on aerocli (psql v14/15 client talks to the v16 server):
#   scp infrastructure/sql/*.sql aerocli:/tmp/
#   sudo dnf install -y postgresql15          # AL2023 (or apt-get install postgresql-client)
#   export PGPASSWORD='<global MASTER_PW>'     # global uses the self-set password
#   psql "host=${GLOBAL_WRITER_ENDPOINT} port=5432 dbname=${DB_NAME} user=${MASTER_USER} sslmode=require" -f /tmp/schema_global.sql
#   psql "host=${GLOBAL_WRITER_ENDPOINT} port=5432 dbname=${DB_NAME} user=${MASTER_USER} sslmode=require" -f /tmp/authz_resolve.sql
#   # local cluster password lives in Secrets Manager (managed); fetch on the dev
#   # machine, then apply schema_local.sql against the LOCAL writer / fleetshell_local.

# echo "# Allow 5432 from the aerocli bastion SG"
# aws ec2 authorize-security-group-ingress --group-id "${DB_SG}" \
#   --ip-permissions '[{"IpProtocol":"tcp","FromPort":5432,"ToPort":5432,"UserIdGroupPairs":[{"GroupId":"sg-011b3ebfcfbcca22d","Description":"aerocli bastion -> Aurora"}]}]' \
#   --region "${REGION}"

# RESULT
# {
#     "Return": true,
#     "SecurityGroupRules": [
#         {
#             "SecurityGroupRuleId": "sgr-00d866ca5ac85342d",
#             "GroupId": "sg-0cab189b921350efd",
#             "GroupOwnerId": "295934382486",
#             "IsEgress": false,
#             "IpProtocol": "tcp",
#             "FromPort": 5432,
#             "ToPort": 5432,
#             "ReferencedGroupInfo": {
#                 "GroupId": "sg-011b3ebfcfbcca22d",
#                 "UserId": "295934382486"
#             },
#             "Description": "aerocli bastion to Aurora"
#         }
#     ]
# }

