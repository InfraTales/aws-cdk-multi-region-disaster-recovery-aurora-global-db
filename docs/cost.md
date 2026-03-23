# Cost Model

## Overview

This is a reference cost model. Actual costs vary by usage, region, and configuration.

## Key Cost Drivers

- Aurora Global Database cross-region replication adds roughly $300-500/month in replication I/O costs on top of the secondary cluster charges — but it compresses RPO from hours (snapshot restore) to under 1 minute of lag [inferred from Aurora Global DB docs]
- DynamoDB Global Tables for session replication doubles write costs since every write is replicated to the DR region — acceptable for session data at this volume but worth isolating to session-only tables rather than general application state [editorial]
- ECS Fargate in the DR region kept at minimal task count (warm standby) adds fixed monthly cost even when idle — the alternative of scaling from zero on failover would blow the 30-minute RTO [inferred]

## Estimated Monthly Cost

| Component | Dev (₹) | Staging (₹) | Production (₹) |
|-----------|---------|-------------|-----------------|
| Compute   | ₹2,000–5,000 | ₹8,000–15,000 | ₹25,000–60,000 |
| Database  | ₹1,500–3,000 | ₹5,000–12,000 | ₹15,000–40,000 |
| Networking| ₹500–1,000   | ₹2,000–5,000  | ₹5,000–15,000  |
| Monitoring| ₹200–500     | ₹1,000–2,000  | ₹3,000–8,000   |
| **Total** | **₹4,200–9,500** | **₹16,000–34,000** | **₹48,000–1,23,000** |

> Estimates based on ap-south-1 (Mumbai) pricing. Actual costs depend on traffic, data volume, and reserved capacity.

## Cost Optimization Strategies

- Use Savings Plans or Reserved Instances for predictable workloads
- Enable auto-scaling with conservative scale-in policies
- Use DynamoDB on-demand for dev, provisioned for production
- Leverage S3 Intelligent-Tiering for infrequently accessed data
- Review Cost Explorer weekly for anomalies
