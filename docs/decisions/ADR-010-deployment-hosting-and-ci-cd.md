# ADR-010: Deployment, Hosting, and CI/CD Architecture

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a deployment, hosting, and CI/CD strategy that ensures automated testing verification, zero unapproved scope deployment, and low operational overhead for MVP.

## 2. Decision Drivers
- **Automated Validation**: Mandatory CI pipeline running linting, type checks, unit tests, and integration tests before deployment.
- **Hosting Cost**: Near-zero idle hosting cost for MVP.
- **Environment Isolation**: Strict separation between development, staging, and production environments.

## 3. Considered Options
* **Option A: GitHub Actions (CI/CD) + Containerized Deployment (Docker + Managed PaaS / Cloud Run / ECS)**
  - *Pros*: Industry standard GitHub Actions integration; containerized deployments ensure identical dev/prod parity; scalable managed container hosting (near-zero idle cost on Serverless/Cloud Run).
  - *Cons*: Container image build pipeline maintenance.

## 4. Decision Outcome
* **Chosen Option**: **GitHub Actions for CI/CD pipeline automation coupled with containerized deployment on managed container infrastructure (e.g., Cloud Run or ECS)**.
* **Justification**: GitHub Actions enforces automated execution of tests, type checking (`tsc`), and linting on every pull request. Containerization ensures the Fastify backend and React frontend deploy reliably with zero environment drift.

## 5. Consequences & Tradeoffs
* **Positive Impact**: Fully automated quality gates; repeatable deployments; scale-to-zero serverless hosting minimizes idle costs.
* **Negative Impact / Tradeoffs**: Container build times in CI.
* **Mitigations**: Layer caching in GitHub Actions.
