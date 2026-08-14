#!/usr/bin/env bash
set -euo pipefail
#
# make_aurora_local.sh
#
# Stand up the REGIONAL (LOCAL) data plane for FleetShell: a *standalone*
# Aurora PostgreSQL cluster (NOT part of the global cluster) that holds data
# which must stay in-region and never replicate worldwide:
#
#     user PII         : firstname, lastname, email, gender, form-of-address
#     group membership : (group_id, user_id)  -- who is actually in a group
#
# WHY A SEPARATE, NON-GLOBAL CLUSTER
# ----------------------------------
# The two-plane split (see AGENTS / design notes): grants operate on GROUPS, so
# the global plane only needs the opaque group_id -- never an individual.  The
# identifying PII and the user<->group mapping stay regional for data residency
# and to shrink breach blast radius.  Because this cluster is standalone, each
# region can own a writable copy independently; there is no cross-region write
# dependency on the hot path (user->groups resolves locally).
#
# IDs ARE GENERATED LOCALLY (no central reserver): user_id / group_id use
# UUIDv7 (or a region-prefix scheme) so they are globally unique by
# construction without a global coordinator.
#
# PREREQUISITE: run make_aurora_global.sh first -- this script REUSES the DB
# subnet group (fleetshell-db-subnets) and DB security group (fleetshell-db-sg)
# created there.  For the initial build the "local" region IS eu-west-2; a real
# second region repeats this script there with its own subnet group + SG.

REGION="eu-west-2"

# Reused from make_aurora_global.sh RESULT:
# DB_SG=""   # <- fill: fleetshell-db-sg GroupId (from global script STEP 3)
DB_SG="sg-0cab189b921350efd"

# Naming:
LOCAL_CLUSTER_ID="fleetshell-local-euw2"
LOCAL_INSTANCE_ID="fleetshell-local-euw2-1"
ENGINE="aurora-postgresql"
ENGINE_VERSION="16.13"
DB_NAME="fleetshell_local"
MASTER_USER="fsadmin"

# ---------------------------------------------------------------------------
# STEP 1 -- Create the standalone regional cluster (no --global-cluster-identifier)
# ---------------------------------------------------------------------------

# echo "# Create local cluster ${LOCAL_CLUSTER_ID}"
# aws rds create-db-cluster \
#   --db-cluster-identifier "${LOCAL_CLUSTER_ID}" \
#   --engine "${ENGINE}" \
#   --engine-version "${ENGINE_VERSION}" \
#   --database-name "${DB_NAME}" \
#   --master-username "${MASTER_USER}" \
#   --manage-master-user-password \
#   --storage-encrypted \
#   --db-subnet-group-name fleetshell-db-subnets \
#   --vpc-security-group-ids "${DB_SG}" \
#   --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=2 \
#   --backup-retention-period 7 \
#   --region "${REGION}"

# RESULT

# # Create local cluster fleetshell-local-euw2
# {
#     "DBCluster": {
#         "AllocatedStorage": 1,
#         "AvailabilityZones": [
#             "eu-west-2a",
#             "eu-west-2b",
#             "eu-west-2c"
#         ],
#         "BackupRetentionPeriod": 7,
#         "DatabaseName": "fleetshell_local",
#         "DBClusterIdentifier": "fleetshell-local-euw2",
#         "DBClusterParameterGroup": "default.aurora-postgresql16",
#         "DBSubnetGroup": "fleetshell-db-subnets",
#         "Status": "creating",
#         "Endpoint": "fleetshell-local-euw2.cluster-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#         "ReaderEndpoint": "fleetshell-local-euw2.cluster-ro-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#         "MultiAZ": false,
#         "Engine": "aurora-postgresql",
#         "EngineVersion": "16.13",
#         "Port": 5432,
#         "MasterUsername": "fsadmin",
#         "PreferredBackupWindow": "01:17-01:47",
#         "PreferredMaintenanceWindow": "tue:03:21-tue:03:51",
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
#         "DbClusterResourceId": "cluster-5VPXEFJZOEG6YLO4YXMOB4ONUM",
#         "DBClusterArn": "arn:aws:rds:eu-west-2:295934382486:cluster:fleetshell-local-euw2",
#         "AssociatedRoles": [],
#         "IAMDatabaseAuthenticationEnabled": false,
#         "ClusterCreateTime": "2026-08-12T16:45:28.184000+00:00",
#         "EngineMode": "provisioned",
#         "DeletionProtection": false,
#         "HttpEndpointEnabled": false,
#         "CopyTagsToSnapshot": false,
#         "CrossAccountClone": false,
#         "DomainMemberships": [],
#         "TagList": [],
#         "AutoMinorVersionUpgrade": true,
#         "ServerlessV2ScalingConfiguration": {
#             "MinCapacity": 0.5,
#             "MaxCapacity": 2.0
#         },
#         "NetworkType": "IPV4",
#         "MasterUserSecret": {
#             "SecretArn": "arn:aws:secretsmanager:eu-west-2:295934382486:secret:rds!cluster-4a19c703-8dc1-4f23-8d36-326d9ca0f398-I6Wbu0",
#             "SecretStatus": "creating",
#             "KmsKeyId": "arn:aws:kms:eu-west-2:295934382486:key/e8a77e5a-0461-4955-a842-10faf509fc36"
#         },
#         "LocalWriteForwardingStatus": "disabled"
#     }
# }


# Capture from RESULT:
LOCAL_WRITER_ENDPOINT="fleetshell-local-euw2.cluster-cpgmocimewi5.eu-west-2.rds.amazonaws.com"   # <- fill from RESULT (.Endpoint)
LOCAL_MASTER_SECRET_ARN="arn:aws:secretsmanager:eu-west-2:295934382486:secret:rds!cluster-4a19c703-8dc1-4f23-8d36-326d9ca0f398-I6Wbu0" # <- fill from RESULT (.MasterUserSecret.SecretArn)

# ---------------------------------------------------------------------------
# STEP 2 -- Create the Serverless v2 writer instance
# ---------------------------------------------------------------------------

# echo "# Create writer instance ${LOCAL_INSTANCE_ID}"
# aws rds create-db-instance \
#   --db-instance-identifier "${LOCAL_INSTANCE_ID}" \
#   --db-cluster-identifier "${LOCAL_CLUSTER_ID}" \
#   --engine "${ENGINE}" \
#   --db-instance-class db.serverless \
#   --region "${REGION}"

# RESULT
# # Create writer instance fleetshell-local-euw2-1
# {
#     "DBInstance": {
#         "DBInstanceIdentifier": "fleetshell-local-euw2-1",
#         "DBInstanceClass": "db.serverless",
#         "Engine": "aurora-postgresql",
#         "DBInstanceStatus": "creating",
#         "MasterUsername": "fsadmin",
#         "DBName": "fleetshell_local",
#         "AllocatedStorage": 1,
#         "PreferredBackupWindow": "01:17-01:47",
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
#         "PreferredMaintenanceWindow": "sun:23:04-sun:23:34",
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
#         "DBClusterIdentifier": "fleetshell-local-euw2",
#         "StorageEncrypted": true,
#         "KmsKeyId": "arn:aws:kms:eu-west-2:295934382486:key/97a3d904-9e94-46ec-9612-1d67acad0711",
#         "DbiResourceId": "db-CFJUZYDDI4RCY53HYXHFNT2M3U",
#         "CACertificateIdentifier": "rds-ca-rsa2048-g1",
#         "DomainMemberships": [],
#         "CopyTagsToSnapshot": false,
#         "MonitoringInterval": 0,
#         "PromotionTier": 1,
#         "DBInstanceArn": "arn:aws:rds:eu-west-2:295934382486:db:fleetshell-local-euw2-1",
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
# STEP 3 -- Wait until available, then confirm the endpoint
# ---------------------------------------------------------------------------

# echo "# Wait for the writer instance to become available"
# aws rds wait db-instance-available \
#   --db-instance-identifier "${LOCAL_INSTANCE_ID}" \
#   --region "${REGION}"

# echo "# Show cluster endpoints"
# aws rds describe-db-clusters \
#   --db-cluster-identifier "${LOCAL_CLUSTER_ID}" \
#   --query 'DBClusters[0].{Writer:Endpoint,Reader:ReaderEndpoint,Status:Status,Secret:MasterUserSecret.SecretArn}' \
#   --region "${REGION}"

# # RESULT

# # Wait for the writer instance to become available
# # Show cluster endpoints
# {
#     "Writer": "fleetshell-local-euw2.cluster-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#     "Reader": "fleetshell-local-euw2.cluster-ro-cpgmocimewi5.eu-west-2.rds.amazonaws.com",
#     "Status": "available",
#     "Secret": "arn:aws:secretsmanager:eu-west-2:295934382486:secret:rds!cluster-4a19c703-8dc1-4f23-8d36-326d9ca0f398-I6Wbu0"
# }

