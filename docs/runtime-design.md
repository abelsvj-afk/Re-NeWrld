# Phase 12: Runtime Design & Lifecycle Architecture (Pass 3 & Final Audit) — Re:NeWrld

Governed by **Project Growth v1.1.0** and [`docs/governance.md`](governance.md).

---

## 1. Introduction & Authority
This document defines the authoritative **Runtime Lifecycle & Execution Architecture** for **Re:NeWrld**. It details the complete request-response lifecycle for reader and creator operations, transactional atomicity between Reader State and Timeline logging, concurrency semantics, Zod validation, observability, runtime security boundaries, and the final Phase 12 Design Gate audit.

---

## 2. Request & Session Lifecycle (Step-by-Step Flow)

For every reader or creator HTTP request entering the Fastify API gateway, the execution lifecycle follows a strict, predictable 9-stage pipeline:

1. **Request Entry & Correlation ID Assignment**:
   - The Fastify gateway intercepts incoming requests (`POST /api/v1/sessions/{id}/choices`, `POST /api/v1/worlds/{id}/publish`).
   - A unique request correlation ID (`x-request-id`) is generated or extracted for structured Pino logging and traceability.

2. **Authentication & Authorization (`AuthMiddleware`)**:
   - Request headers are inspected for secure HttpOnly session cookies or JWT bearer tokens.
   - RBAC middleware verifies user identity, role (Creator vs. Reader vs. Operator), and resource ownership.

3. **Input Validation & Sanitization (`Zod` Validation Layer)**:
   - Payload schemas are validated against strict **Zod** runtime schemas (authoritative contract layer per ADR-003). Invalid structures fail immediately with a 400 Bad Request error envelope.

4. **Canon & State Resolution (`CanonStore` & `StateStore`)**:
   - Loads active World Canon (scenes, nodes, choices, conditions) and current Reader Session State (`currentNodeId`, variable map, visit counts).

5. **Deterministic Narrative Execution (`DeterministicEngine`)**:
   - Evaluates condition expressions against the current state variable map.
   - Resolves available choices, calculates numeric/boolean mutations, and determines the target next node ID via pure functions.

6. **Timeline Recording (`TimelineStore`)**:
   - Appends the executed choice, previous node, resulting node, and state variable diff to the immutable reader session timeline log.

7. **Persistence & ACID Transaction Commit (`TransactionManager`)**:
   - State mutation and timeline appends execute within a single ACID-compliant PostgreSQL transaction block (`BEGIN` -> `MUTATE state` -> `INSERT timeline` -> `COMMIT`).
   - Any failure triggers an immediate `ROLLBACK`.

8. **Response Formatting & Headers**:
   - Serializes resulting state, available choices, rendered text, and metadata into the standardized API response envelope.

9. **Failure Handling & Error Containment**:
   - Catches unhandled exceptions, sanitizes stack traces, and logs with correlation IDs.

---

## 3. Transaction Atomicity, Concurrency & Conflict Semantics

- **Atomicity Guarantee**: Reader State mutation and Timeline log appending are strictly bound to the same PostgreSQL transaction. Under no circumstances can a state mutation commit without its corresponding timeline record, nor can a timeline entry exist for an aborted state mutation.
- **Concurrency & Locking**:
   - Reader sessions utilize row-level locking (`SELECT ... FOR UPDATE`) and version integers (`version INTEGER`) to prevent race conditions during rapid choice submissions.
   - Idempotency keys (`X-Idempotency-Key`) ensure duplicate network requests return cached successful responses without re-executing state transitions.
   - Conflict handling: Version mismatches return a `409 Conflict` error prompting client state re-synchronization.

---

## 4. Session Lifecycle, Authentication & Failure Handling

- **Session Lifecycle**: Created via `POST /api/v1/worlds/{world_id}/sessions`, binding the session to a specific published Canon version snapshot. Sessions remain active until closed or expired.
- **Auth Failure Handling**: Invalid or expired tokens result in `401 Unauthorized`. Accessing unowned worlds or unauthorized endpoints results in `403 Forbidden`.
- **Timeouts & Recovery**: Fastify routes enforce strict request timeout limits (5s for choices, 15s for publishing). Database timeouts or connection drops trigger exponential backoff retries (max 3 attempts) before failing safely with `503 Service Unavailable`.

---

## 5. Observability & Runtime Security Boundaries

- **Observability**: All runtime operations emit structured JSON logs via Pino, capturing timestamps, correlation IDs, execution duration, and outcome status codes.
- **Security Boundaries**:
   - **Isolation**: Reader state is strictly scoped to the authenticated reader ID; cross-reader access is blocked at the middleware layer.
   - **Canon Integrity**: Runtime execution cannot mutate Published Canon; published content is read-only.
   - **Zod Validation**: All inbound payloads are strictly validated via Zod schemas, preventing injection or malformed data injection.

---

## 6. Phase 12 Design Gate Audit

| Audit Criterion | Evaluation | Status |
|---|---|---|
| Request/Session Lifecycle Completeness | 9-stage pipeline covers entry, auth, Zod validation, canon resolution, deterministic execution, timeline recording, ACID commit, response, and error handling. | **PASS** |
| Transaction Atomicity & Rollback | Reader State and Timeline recording are strictly bound in a single ACID transaction with automated rollback on failure. | **PASS** |
| Concurrency & Conflict Resolution | Optimistic locking, version counters, row-level locks (`FOR UPDATE`), and idempotency keys prevent race conditions. | **PASS** |
| Auth & Failure Semantics | 401/403 for auth failures, 409 for concurrency conflicts, 503 with exponential backoff for transient DB errors. | **PASS** |
| Observability & Security Boundaries | Structured Pino logging with correlation IDs, Zod runtime validation, and strict multi-tenant reader session isolation. | **PASS** |

- **Audit Result**: **PASS** with zero remaining gaps.
