# ADR-011: Secrets, Configuration, and Data Backup/Recovery Architecture

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires secure secret management, configuration handling, and robust database backup and disaster recovery procedures to protect creator IP and reader state data.

## 2. Decision Drivers
- **Credential Protection**: Zero hardcoded secrets; strict adherence to credential security mandates.
- **Disaster Recovery**: Automated database backups and tested restore procedures.

## 3. Considered Options
* **Option A: Environment Variables (`process.env`) with Managed Secret Stores + Automated Daily DB Snapshots**
  - *Pros*: Simple, secure when managed via PaaS secret managers, reliable automated point-in-time recovery via managed PostgreSQL.
  - *Cons*: Requires disciplined secret rotation.

## 4. Decision Outcome
* **Chosen Option**: **Environment-based configuration validated at startup via Zod schemas, backed by managed cloud secret storage and automated daily PostgreSQL database snapshots with point-in-time recovery (PITR)**.
* **Justification**: Validating all configuration variables at startup ensures missing or malformed database URLs or encryption keys fail fast before the server accepts traffic. Managed PostgreSQL automated backups guarantee recovery from catastrophic data loss.

## 5. Consequences & Tradeoffs
* **Positive Impact**: Fail-fast startup security; bulletproof data durability and recovery paths.
* **Negative Impact / Tradeoffs**: Reliance on cloud provider managed backup services.
* **Mitigations**: Periodic manual restore dry-runs in staging environments.
