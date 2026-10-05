# ADR-008: Observability, Logging, and Error Reporting Architecture

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a comprehensive observability, logging, and error-reporting strategy to guarantee auditability, distributed tracing via request correlation IDs, and rapid diagnosis of state persistence or validation failures.

## 2. Decision Drivers
- **Request Correlation**: Unique Request IDs attached to all logs and transactions for distributed tracing.
- **Structured JSON Logging**: Machine-parsable log streams.
- **Security**: Zero PII or secrets logged.

## 3. Considered Options
* **Option A: Pino (Fastify native logger) + Structured JSON Logging + Request ID Middleware**
  - *Pros*: Blazing fast, native Fastify integration, automatic PII redaction capabilities, structured JSON output.
  - *Cons*: Requires centralized log ingestion collector in production.

## 4. Decision Outcome
* **Chosen Option**: **Pino structured JSON logger with Fastify request ID correlation middleware and centralized log aggregation**.
* **Justification**: Pino is the fastest logger for Node.js/Fastify, ensuring observability logging never becomes a performance bottleneck. Request IDs provide immediate provenance tracing for state transitions and publishing validation runs.

## 5. Consequences & Tradeoffs
* **Positive Impact**: High performance; clean JSON structure; robust tracing capabilities.
* **Negative Impact / Tradeoffs**: Requires configuring log rotation and retention policies.
* **Mitigations**: Standard log retention schedules compliant with data governance rules.
