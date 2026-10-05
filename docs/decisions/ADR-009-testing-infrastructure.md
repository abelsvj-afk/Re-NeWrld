# ADR-009: Testing Infrastructure Architecture

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a rigorous testing infrastructure covering unit tests, integration tests, and deterministic engine verification to guarantee state fidelity, validation rule enforcement, and regression prevention.

## 2. Decision Drivers
- **Deterministic Verification**: Ability to assert 100% testable state transitions and condition evaluations.
- **Developer Ergonomics**: Fast test runner execution.
- **Coverage**: Comprehensive unit and integration test suites.

## 3. Considered Options
* **Option A: Vitest + Supertest + PostgreSQL Testcontainers**
  - *Pros*: Native TypeScript support, lightning-fast execution, isolated test containers for PostgreSQL integration tests, robust mocking.
  - *Cons*: Requires Docker daemon for Testcontainers.

## 4. Decision Outcome
* **Chosen Option**: **Vitest for unit/integration testing and PostgreSQL Testcontainers for isolated database integration tests**.
* **Justification**: Vitest integrates seamlessly with TypeScript and Vite/Node stacks. Testcontainers ensure database integration tests run against a real PostgreSQL instance with identical constraints and triggers, guaranteeing publishing validation and state rollback logic are thoroughly verified.

## 5. Consequences & Tradeoffs
* **Positive Impact**: High test fidelity; rapid feedback loop; zero database pollution across test runs.
* **Negative Impact / Tradeoffs**: Test environment requires Docker availability.
* **Mitigations**: Standard CI/CD runner environments equipped with Docker-in-Docker support.
