# Architecture Notes

## Overview

The stack spans us-east-2 (primary) and us-east-1 (DR) using Aurora Global Database for sub-second cross-region replication, DynamoDB Global Tables for session state, and ECS Fargate behind Application Load Balancers in each region. Route 53 health checks drive automated DNS failover, while a Lambda-based failover orchestrator — triggered by EventBridge alarms — handles the RDS cluster promotion sequence and ALB target group updates. All data at rest and in transit is encrypted via KMS customer-managed keys, with secrets stored in Secrets Manager per region. The non-obvious design choice is using an inline Lambda health checker that polls both RDS cluster status and ALB target health before EventBridge fires the failover sequence, adding a validation gate that prevents split-brain during a partial outage.

## Key Decisions

- Aurora Global Database cross-region replication adds roughly $300-500/month in replication I/O costs on top of the secondary cluster charges — but it compresses RPO from hours (snapshot restore) to under 1 minute of lag [inferred from Aurora Global DB docs]
- DynamoDB Global Tables for session replication doubles write costs since every write is replicated to the DR region — acceptable for session data at this volume but worth isolating to session-only tables rather than general application state [editorial]
- ECS Fargate in the DR region kept at minimal task count (warm standby) adds fixed monthly cost even when idle — the alternative of scaling from zero on failover would blow the 30-minute RTO [inferred]
- The inline Lambda health check code baked into CDK using Code.fromInline() is convenient but untestable in isolation — any logic bug ships silently and only surfaces during an actual failover [from-code]
- KMS customer-managed keys per region require explicit cross-region key grants for Aurora snapshot copying, which is a setup step teams frequently miss until the first DR drill [editorial]