# TASKS — Re:NeWrld

Governed by **Project Growth v1.1.0** and [`docs/governance.md`](governance.md).

---

## 1. Task Generation Guidelines & Rules
- **Granularity**: Every task is independently executable, testable, and scoped to complete in under 4 hours.
- **Traceability**: Every task maps directly to an approved roadmap phase, requirement, user story, design specification, service specification, ADR, or security constraint.
- **Testing**: Continuous testing accompanies implementation (Vitest unit tests & PostgreSQL Testcontainers integration tests).
- **Quality**: Tasks explicitly specify prerequisites, file scope, acceptance criteria, required tests, and definition of done.

---

## 2. MVP Implementation Backlog (Critical Path & Supporting Tasks)

### Roadmap Phase A: Repository Foundation & Bootstrap
- **Task A1: Initialize Modular Monolith Directory Structure & Build Configuration**
  - **Phase**: Phase A (Bootstrap)
  - **Prerequisites**: None (Root foundation)
  - **Ownership**: `src/`, root config
  - **File Scope**: `package.json`, `tsconfig.json`, `src/server.ts`, `src/app.ts`
  - **Objective**: Establish Fastify bootstrap, TypeScript compiler options, and project folder skeleton.
  - **Traceability**: `docs/architecture.md`, ADR-001
  - **Acceptance Criteria**: TypeScript compiles cleanly (`tsc`), Fastify server boots successfully.
  - **Required Tests**: Unit test verifying app bootstrap and health check endpoint.
  - **Definition of Done**: Code structured per `docs/repository-architecture.md`, passing lint and build.

- **Task A2: Implement Centralized Zod Environment Validation**
  - **Phase**: Phase A (Bootstrap)
  - **Prerequisites**: Task A1
  - **Ownership**: `src/config/`
  - **File Scope**: `src/config/env.ts`, `.env.example`
  - **Objective**: Enforce strict Zod validation of environment variables and secrets at startup.
  - **Traceability**: `docs/operations.md`, ADR-011
  - **Acceptance Criteria**: Missing environment variables cause immediate startup failure with clear error reporting.
  - **Required Tests**: Unit tests for valid and invalid environment configurations.
  - **Definition of Done**: Zod schema operational, unvalidated `process.env` access eliminated.

- **Task A3: Configure Pino Structured Logger with Correlation ID Tracking**
  - **Phase**: Phase A (Bootstrap)
  - **Prerequisites**: Task A1
  - **Ownership**: `src/shared/logger/`
  - **File Scope**: `src/shared/logger/pino.logger.ts`, Fastify request ID hook
  - **Objective**: Implement structured JSON logging capturing request correlation IDs (`x-request-id`).
  - **Traceability**: `docs/automation-design.md`, ADR-008
  - **Acceptance Criteria**: All log events include correlation ID and structured metadata.
  - **Required Tests**: Unit test verifying correlation ID propagation and Pino output formatting.
  - **Definition of Done**: Logger operational across application bootstrap and request lifecycle.

---

### Roadmap Phase B: Database & Persistence Layer
- **Task B1: Establish PostgreSQL Connection Pool Infrastructure**
  - **Phase**: Phase B (Persistence)
  - **Prerequisites**: Task A2
  - **Ownership**: `src/shared/database/`
  - **File Scope**: `src/shared/database/db.ts` (PostgreSQL connection pool client)
  - **Objective**: Configure secure PostgreSQL connection pooling adhering to shared governance rules, keeping domain repositories, migrations, and cross-cutting transaction orchestration out of shared.
  - **Traceability**: `docs/architecture.md`, ADR-002
  - **Acceptance Criteria**: Connection pool establishes successfully using validated environment configuration; no domain or repository abstractions placed in shared.
  - **Required Tests**: Integration test connecting to PostgreSQL Testcontainers instance and verifying connectivity.
  - **Definition of Done**: Database connection client operational and verified against Testcontainers.

- **Task B2: Implement Versioned SQL Schema Migrations & Migration Runner**
  - **Phase**: Phase B (Persistence)
  - **Prerequisites**: Task B1
  - **Ownership**: `db/migrations/`, `scripts/`
  - **File Scope**: Versioned SQL migration files, migration runner script
  - **Objective**: Create versioned SQL migration scripts for users, worlds, draft graphs, published canon, sessions, and timelines.
  - **Traceability**: `docs/detailed-design.md`, ADR-002
  - **Acceptance Criteria**: Migrations execute sequentially and idempotently against target database per approved schema specifications.
  - **Required Tests**: Integration test verifying migration execution and schema integrity.
  - **Definition of Done**: All database tables, indexes, and foreign keys successfully created via migration script.

---

### Roadmap Phase C: Authentication & Authorization (RBAC)
- **Task C1: Implement User Entity, Value Objects & Auth Repository Port**
  - **Phase**: Phase C (Auth/RBAC)
  - **Prerequisites**: Task B2
  - **Ownership**: `src/modules/auth/domain/`
  - **File Scope**: `src/modules/auth/domain/entities/user.ts`, repository ports
  - **Objective**: Define pure domain model for users, roles (Creator vs. Reader), and auth repository interfaces.
  - **Traceability**: `docs/service-specifications.md`, ADR-004
  - **Acceptance Criteria**: Domain entities encapsulate validation rules with zero external framework dependencies.
  - **Required Tests**: Vitest unit tests covering user domain invariants and role rules.
  - **Definition of Done**: Domain core fully tested and isolated.

- **Task C2: Implement Session-Based Authentication & Secure Cookie Service**
  - **Phase**: Phase C (Auth/RBAC)
  - **Prerequisites**: Task C1
  - **Ownership**: `src/modules/auth/infrastructure/`
  - **File Scope**: PostgreSQL user repository adapter, secure session cookie service adapter
  - **Objective**: Implement secure, HttpOnly, SameSite=Strict session cookie generation and server-side session store validation (ADR-004).
  - **Traceability**: `docs/threat-model.md`, ADR-004
  - **Acceptance Criteria**: Sessions securely issued, validated against server store, and immediately revocable.
  - **Required Tests**: Integration tests verifying cookie flags and session lookup/revocation.
  - **Definition of Done**: Secure authentication adapter operational.

- **Task C3: Implement Fastify RBAC Security Middleware**
  - **Phase**: Phase C (Auth/RBAC)
  - **Prerequisites**: Task C2
  - **Ownership**: `src/modules/auth/application/` & middleware
  - **File Scope**: `src/shared/middleware/auth.middleware.ts`, RBAC authorization guards
  - **Objective**: Implement Fastify pre-handler middleware enforcing Creator vs. Reader permissions on protected routes.
  - **Traceability**: `docs/requirements.md`, ADR-004
  - **Acceptance Criteria**: Unauthorized requests receive `401 Unauthorized`; mismatched roles receive `403 Forbidden`.
  - **Required Tests**: Integration tests verifying route protection for Creator-only and Reader-only endpoints.
  - **Definition of Done**: RBAC middleware active across API route definitions.

- **Task C4: Implement Password Reset & Account Recovery**
  - **Phase**: Phase C (Auth/RBAC)
  - **Prerequisites**: Task C2 (session service with `revokeAllUserSessions`); ADR-012 accepted 2026-10-13; email provider: Resend (free tier)
  - **Status**: ✅ Implemented 2026-10-13 — 111/111 unit tests pass, tsc clean.
  - **Ownership**: `src/modules/auth/`
  - **File Scope**: `src/modules/auth/application/request-password-reset.use-case.ts`, `src/modules/auth/application/confirm-password-reset.use-case.ts`, `src/modules/auth/application/ports/email-service.port.ts`, `src/modules/auth/infrastructure/persistence/postgres-password-reset.repository.ts`, `src/modules/auth/infrastructure/email/*` (adapter), `src/modules/auth/http/auth.routes.ts`, `db/migrations/003_password_reset_tokens.sql`, session janitor extension in `src/server.ts`
  - **Objective**: Implement FR-13 / US-A01: time-limited, single-use, hashed reset tokens delivered via email; anti-enumeration request endpoint; session revocation on confirm.
  - **Traceability**: `docs/requirements.md` (FR-13), `docs/user-stories.md` (US-A01), ADR-012, `docs/threat-model.md`
  - **Acceptance Criteria**:
    - `POST /auth/password-reset/request` returns `202` with identical timing/response whether or not the email is registered.
    - Reset tokens are 256-bit random, SHA-256 hashed at rest, single-use, 15-minute expiry; raw tokens never logged or persisted.
    - `POST /auth/password-reset/confirm` with a valid token updates the password (existing scrypt service), marks the token used, and revokes all sessions via `revokeAllUserSessions`.
    - Expired, reused, or invalid tokens return a generic `400`.
    - Strict per-IP rate limits on both endpoints (abuse target).
    - Expired tokens purged by the janitor.
  - **Required Tests**: Unit tests for both use cases (token lifecycle, expiry, reuse, anti-enumeration); integration tests for the endpoints including rate-limit behavior and session revocation.
  - **Definition of Done**: Full request→email→confirm→login-with-new-password flow verified; ADR-012 marked Accepted; threat-model rows marked Mitigated.

---

### Roadmap Phase D: Creator & World Authoring Subsystem
- **Task D1: Implement World, Character, Story & Scene Domain Entities**
  - **Phase**: Phase D (Authoring)
  - **Prerequisites**: Task C3
  - **Ownership**: `src/modules/world/domain/`
  - **File Scope**: `src/modules/world/domain/entities/`
  - **Objective**: Model core authoring aggregates and draft world graph invariants in pure TypeScript.
  - **Traceability**: `docs/detailed-design.md`, `docs/user-stories.md`
  - **Acceptance Criteria**: Domain entities enforce node connectivity and structural integrity invariants.
  - **Required Tests**: Vitest unit tests verifying domain entity creation and validation rules.
  - **Definition of Done**: World authoring domain core fully tested.

- **Task D2: Implement Creator World Authoring Use Cases & Persistence Adapter**
  - **Phase**: Phase D (Authoring)
  - **Prerequisites**: Task D1
  - **Ownership**: `src/modules/world/application/` & `infrastructure/`
  - **File Scope**: Authoring use cases, PostgreSQL draft world repository adapter
  - **Objective**: Enable Creators to create and modify draft worlds, scenes, and narrative nodes within isolated authoring tables.
  - **Traceability**: `docs/service-specifications.md`, `docs/user-stories.md`
  - **Acceptance Criteria**: Only authenticated Creators owning the world can modify draft authoring records.
  - **Required Tests**: Integration tests covering authoring use cases and database persistence.
  - **Definition of Done**: Creator authoring workflows operational and secured via RBAC.

---

### Roadmap Phase E: Story, Scene & Publishing Validation
> **Status note (2026-10-13 audit)**: Phase E was marked complete, but E1/E2 were never implemented — the world module is draft CRUD only. The schema for publishing already exists (migration 001: `published_canon_snapshots`, `reader_sessions`, `reader_timelines`); only application code is missing, plus two schema gaps (no terminal-ending flag despite `detailed-design.md:63` specifying `ending: true`; no start-scene designation anywhere). Tasks below close the gap in dependency order. Design: ADR-013 (Proposed).

- **Task E0: Complete Draft Schema for Publishing (start scene + terminal endings)**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task D2
  - **Ownership**: `db/migrations/`, `src/modules/world/domain/`
  - **File Scope**: `db/migrations/004_publishing_markers.sql` (new), `src/modules/world/domain/entities/scene.entity.ts`, `src/modules/world/domain/entities/world.entity.ts`, repository mappers
  - **Objective**: Add the two markers the design docs assume but code lacks: `is_ending` on scenes (implements `detailed-design.md:63`'s `ending: true`) and `start_scene_id` on worlds (one entry point per world, FK-guarded). This implements defined design; it invents no new schema.
  - **Traceability**: `docs/detailed-design.md`, ADR-013 §3
  - **Acceptance Criteria**:
    - Migration 004 adds `scenes.is_ending BOOLEAN NOT NULL DEFAULT FALSE` and `worlds.start_scene_id UUID REFERENCES scenes(scene_id)` (nullable until set).
    - Entities expose `isEnding` / `startSceneId` with validation; repository round-trips preserve them.
    - Publishing (E2a) rejects worlds with no start scene set (blocker per ADR-013 §5).
  - **Required Tests**: Unit tests for entity validation; repository mapper round-trip tests.
  - **Definition of Done**: Schema markers present, entities enforce them, migration runs cleanly on a fresh database.

- **Task E1a: Implement Graph Reachability Validator (pure domain service)**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task E0
  - **Ownership**: `src/modules/world/domain/services/` (new)
  - **File Scope**: `src/modules/world/domain/services/graph-validator.ts` (new), unit tests
  - **Objective**: Pure-function graph traversal from the world's designated start scene: compute reachable scenes, detect unreachable scenes (warnings, not blockers), verify at least one `is_ending` scene is reachable (blocker if none).
  - **Traceability**: FR-05, ADR-013 §5
  - **Acceptance Criteria**:
    - Returns `{ reachable, unreachable, reachableEndings, errors }`; blockers: no start scene, no scenes at all, zero reachable endings.
    - Unreachable well-formed scenes appear in `unreachable`, never in `errors`.
    - Pure: no DB, no I/O, deterministic; handles cycles without infinite loops.
  - **Required Tests**: Unit tests — linear chain, branching, cycle, disconnected subgraph (warning), no endings (blocker), empty world (blocker), diamond merge.
  - **Definition of Done**: All topologies pass; full branch coverage of the traversal.

- **Task E1b: Implement Reference Validator (choice targets)**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task E1a
  - **Ownership**: `src/modules/world/domain/services/`
  - **File Scope**: `src/modules/world/domain/services/graph-validator.ts`, unit tests
  - **Objective**: Validate structural references: every choice's target scene exists (dangling target = blocker). Condition/mutation *semantic* reference validation is explicitly out of scope — conditions are opaque JSON until the G1 grammar lands (documented limitation, ADR-013 §5).
  - **Traceability**: FR-05, ADR-013 §5
  - **Acceptance Criteria**:
    - Every choice target resolves to an existing scene; dangling targets are blockers identifying the choice and scene.
    - All dangling references reported, not just the first.
  - **Required Tests**: Unit tests — valid graph, dangling target, self-loop (valid), multiple dangling targets.
  - **Definition of Done**: All dangling references detected with locations.

- **Task E2a: Implement Publish Use Case & Snapshot Repository**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task E1b
  - **Ownership**: `src/modules/world/application/`, `src/modules/world/infrastructure/persistence/`
  - **File Scope**: `publish-world.use-case.ts` (new), `postgres-canon.repository.ts` (new), `canon.repository.port.ts` (new domain port)
  - **Objective**: Creator-triggered publishing: run E1a+E1b validators → on blockers, return the validation report without writing; on pass, serialize the draft graph into `canon_data` JSONB and INSERT a new `published_canon_snapshots` row with `version_number = max + 1`. Never UPDATE snapshots.
  - **Traceability**: FR-05, `docs/detailed-design.md`, ADR-013
  - **Acceptance Criteria**:
    - Validation blockers abort publishing with typed errors listing every blocker and warning.
    - Success creates exactly one snapshot row; `version_number` increments per world; `canon_data` deep-equals the draft graph at publish time.
    - Re-publishing after draft edits creates a new version; earlier snapshots byte-identical.
    - Error cases: world not found / not owned (404-not-403 per world route convention), no start scene, validation blockers.
  - **Required Tests**: Unit tests with fake repos (blocker abort, version increment, snapshot content); integration tests for persistence and version sequencing (Testcontainers — UNVERIFIED until Docker/CI runs them).
  - **Definition of Done**: Validated drafts produce versioned, immutable snapshots; invalid drafts never write.

- **Task E2b: Implement Publish API Route (creator-only)**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task E2a
  - **Ownership**: `src/modules/world/http/`
  - **File Scope**: `src/modules/world/http/world.routes.ts`
  - **Objective**: `POST /worlds/:id/publish` — creator-only, 404-not-403 ownership semantics (matches existing world routes). Returns `{ snapshotId, versionNumber, warnings[] }` on 201; 422 with `{ blockers[], warnings[] }` on validation failure.
  - **Traceability**: FR-05, ADR-003 (Zod validation)
  - **Acceptance Criteria**:
    - Readers receive 403; strangers/unknown worlds receive 404; creators receive 201 or 422.
    - 422 body distinguishes blockers from warnings.
  - **Required Tests**: Route tests via `buildApp` + inject with fakes — 201/404/403/422 cases.
  - **Definition of Done**: Publishing operable over HTTP with typed errors.

- **Task E2c: Enforce Canon Immutability (trigger + tests)**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task E2a
  - **Ownership**: `db/migrations/`, tests
  - **File Scope**: `db/migrations/005_canon_immutability.sql` (new), immutability tests
  - **Objective**: Defense in depth for ADR-013 D1: PostgreSQL trigger rejecting UPDATE and DELETE on `published_canon_snapshots`, plus tests proving both application paths and direct SQL cannot mutate canon. Trigger guards row mutation only — DDL/migrations unaffected; FK references use `ON DELETE RESTRICT` (already the case); retention/account-deletion design explicitly deferred.
  - **Traceability**: ADR-013 §4 (D1)
  - **Acceptance Criteria**:
    - Migration 005 creates the trigger; fresh-database migration run is clean.
    - Direct UPDATE/DELETE against snapshots raises; the error surfaces, never swallowed.
    - Application repository exposes no update/delete method for snapshots (port-surface test).
  - **Required Tests**: Integration test executing raw UPDATE/DELETE and asserting rejection (Testcontainers — UNVERIFIED until Docker/CI runs it); unit test asserting the port has no mutating methods beyond insert.
  - **Definition of Done**: Canon immutable at both layers; trigger documented in the migration header.

---

### Roadmap Phase F: Reader Runtime, State & Timeline Experience
> **Status note (2026-10-13 audit)**: Prerequisites are Task C3 (done) and Task E2 (was missing — now specified above as E0–E2c). Per AGENTS.md prerequisite rules, F-tasks begin only after E2c is verified. Design: `docs/runtime-design.md` (authoritative), ADR-013 (Proposed). Idempotency contract is specified in ADR-013 §4 (D3); enforcement lands with Phase G choice submission.

- **Task F1a: Implement Reader Session Domain Entity & Repository Port**
  - **Phase**: Phase F (Reader Runtime)
  - **Prerequisites**: Task E2c
  - **Ownership**: `src/modules/session/domain/` (exists as empty scaffolding)
  - **File Scope**: `src/modules/session/domain/entities/reader-session.entity.ts` (new), `src/modules/session/domain/ports/session.repository.port.ts` (new), value objects as needed
  - **Objective**: Pure domain model for a reader playthrough: session bound to a `snapshot_id`, `currentSceneId`, JSON state-variable map, optimistic-locking `version`, status lifecycle `active → completed | abandoned`. Status transitions validated in the entity (`completed` only via reaching a terminal ending; `abandoned` via explicit close).
  - **Traceability**: `docs/runtime-design.md` §4, ADR-013 §4 (D2)
  - **Acceptance Criteria**:
    - Entity enforces invariants: session references a snapshot (never a mutable draft), state map is JSON-serializable, version increments only via `applyTransition`.
    - Illegal transitions (e.g., `completed → active`) throw typed domain errors.
  - **Required Tests**: Unit tests — invariant violations, transition rules, version increment.
  - **Definition of Done**: Domain core fully tested and isolated from infrastructure.

- **Task F1b: Implement Session Initialization Use Case**
  - **Phase**: Phase F (Reader Runtime)
  - **Prerequisites**: Task F1a
  - **Ownership**: `src/modules/session/application/` (exists as empty scaffolding)
  - **File Scope**: `start-reader-session.use-case.ts` (new), unit tests with fakes
  - **Objective**: Start a new playthrough: resolve the world's latest published snapshot (error if none published), create the session pinned to that `snapshot_id` with `currentSceneId` = canon start scene and empty initial state. Multiple sessions per reader per world allowed (ADR-013 D2) — no uniqueness constraint beyond the primary key.
  - **Traceability**: US-R01, `docs/runtime-design.md` §4
  - **Acceptance Criteria**:
    - World with no published snapshot → typed error (HTTP 409 with clear message at the route layer).
    - Session row references the latest snapshot version at creation time; later publishes do not move it.
    - Error cases: unknown world (404), unpublished world (409).
  - **Required Tests**: Unit tests with fakes — happy path, no-snapshot error, snapshot pinning across a subsequent publish.
  - **Definition of Done**: Session initialization logic verified independent of HTTP.

- **Task F1c: Implement Session HTTP Routes (reader-owned)**
  - **Phase**: Phase F (Reader Runtime)
  - **Prerequisites**: Task F1b
  - **Ownership**: `src/modules/session/http/` (new), `src/app.ts`
  - **File Scope**: `src/modules/session/http/session.routes.ts` (new), route tests
  - **Objective**: `POST /worlds/:id/sessions` (create playthrough; any authenticated reader), `GET /sessions/:id` (owner-only; 404-not-403 for other readers' sessions, mirroring world route conventions). Session cookie auth via existing middleware; `requireReader` (kept deliberately for this phase) gates creation.
  - **Traceability**: US-R01, US-R05, ADR-003 (Zod validation)
  - **Acceptance Criteria**:
    - 201 with `{ sessionId, snapshotId, versionNumber, currentSceneId, status }` on create; 409 when the world has no published snapshot.
    - Cross-reader access returns 404 (not 403 — no existence oracle), unauthenticated returns 401.
    - Zod-validated bodies; invalid payloads → 400.
  - **Required Tests**: Route tests via `buildApp` + inject with fakes — 201/401/404/409 cases, ownership isolation.
  - **Definition of Done**: Session lifecycle operable over HTTP with correct authorization.

- **Task F2a: Implement Atomic State Mutation & Timeline Append**
  - **Phase**: Phase F (Reader Runtime)
  - **Prerequisites**: Task F1c
  - **Ownership**: `src/modules/session/infrastructure/` (exists as empty scaffolding)
  - **File Scope**: `postgres-session.repository.ts` (new), transaction handling, integration tests
  - **Objective**: The persistence mechanism for choice application (resolution logic itself is Phase G): within a single transaction — `SELECT ... FOR UPDATE` the session row, check optimistic `version` (mismatch → 409, per runtime-design), apply the state diff to `state_variables`, INSERT the timeline row (next `sequence_number`), UPDATE the session (`version + 1`, `updated_at`). Any failure → ROLLBACK. Timeline rows are append-only (no update/delete path).
  - **Traceability**: `docs/runtime-design.md` §3, ADR-002
  - **Acceptance Criteria**:
    - State mutation and timeline append commit atomically; induced failure mid-transaction rolls back both.
    - Concurrent conflicting writes → one wins, the other gets 409 (version mismatch).
    - Timeline `sequence_number` is gapless per session (unique constraint enforced).
    - No code path issues UPDATE/DELETE against `reader_timelines` or `published_canon_snapshots`.
  - **Required Tests**: Integration tests with Testcontainers simulating commit, rollback on failure, and concurrent version conflicts — **UNVERIFIED until Docker/CI runs them** (no Docker in this environment); unit tests for the diff-application logic with fakes.
  - **Definition of Done**: Atomicity guarantees verified; Docker-dependent tests explicitly marked UNVERIFIED, never claimed passing.
  - **System Completeness Gate (slice)**: Security — session ownership enforced at repository level (reader_id predicate on every query); Reliability — transaction boundaries + rollback; Data Governance — timeline append-only, state minimization (only gameplay variables, no PII); AI Safety — N/A (deterministic persistence, no model involvement).

---

### Roadmap Phase G: Deterministic Narrative Execution
- **Task G1: Implement Pure Condition Evaluation Engine**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Task F1
  - **Ownership**: `src/modules/session/domain/services/`
  - **File Scope**: Condition evaluation domain service
  - **Objective**: Implement pure function condition evaluation rules against reader state variable maps.
  - **Traceability**: `docs/detailed-design.md`, `docs/service-specifications.md`
  - **Acceptance Criteria**: Evaluates complex boolean and numeric conditions deterministically with zero side effects.
  - **Required Tests**: 100% Vitest unit test coverage for condition evaluation edge cases.
  - **Definition of Done**: Condition evaluator service fully tested and isolated.

- **Task G2: Implement State Transition & Narrative Choice Resolution Use Case**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Task F2, Task G1
  - **Ownership**: `src/modules/session/application/`
  - **File Scope**: Session application use case, narrative resolver service
  - **Objective**: Execute deterministic session choice progression in the application layer: validate input, resolve condition, evaluate state transition, and append timeline within transaction boundaries, returning structured results without handling transport HTTP concerns.
  - **Traceability**: `docs/runtime-design.md`, `docs/user-stories.md`
  - **Acceptance Criteria**: Choice selection correctly updates reader state, logs timeline history, and returns next scene node.
  - **Required Tests**: Integration tests verifying end-to-end choice progression and timeline logging.
  - **Definition of Done**: Deterministic narrative execution engine fully operational.

---

### Roadmap Phase H: API & Frontend Integration
- **Task H1a: Implement Auth & Session REST API Controllers and Zod Validation**
  - **Phase**: Phase H (API/Frontend)
  - **Prerequisites**: Task C3, Task F1
  - **Ownership**: `src/modules/auth/presentation/` & `src/modules/session/presentation/`
  - **File Scope**: Auth and session route controllers, Zod validation schemas
  - **Objective**: Expose secure authentication and session REST endpoints validated via Zod schemas (ADR-003).
  - **Traceability**: `docs/architecture.md`, ADR-003
  - **Acceptance Criteria**: Invalid payloads return `400 Bad Request`; valid requests return expected responses.
  - **Required Tests**: Integration tests covering auth and session API routes.
  - **Definition of Done**: Auth and session REST endpoints exposed and validated.

- **Task H1b: Implement World Authoring & Publishing REST API Controllers and Zod Validation**
  - **Phase**: Phase H (API/Frontend)
  - **Prerequisites**: Task D2, Task E2
  - **Ownership**: `src/modules/world/presentation/`
  - **File Scope**: World authoring and publishing route controllers, Zod validation schemas
  - **Objective**: Expose secure creator authoring and publishing REST endpoints validated via Zod schemas (ADR-003).
  - **Traceability**: `docs/architecture.md`, ADR-003
  - **Acceptance Criteria**: Creator endpoints enforce RBAC and validate request payloads via Zod.
  - **Required Tests**: Integration tests covering world authoring and publishing API routes.
  - **Definition of Done**: World authoring and publishing REST endpoints exposed and validated.

- **Task H2: Implement React SPA Frontend Shell, Auth & Navigation**
  - **Phase**: Phase H (API/Frontend)
  - **Prerequisites**: Task H1a, Task H1b
  - **Ownership**: `src/web/`
  - **File Scope**: React frontend client shell, authentication context, router
  - **Objective**: Build React SPA client shell supporting Creator and Reader authentication and view routing (ADR-001).
  - **Traceability**: `docs/vision.md`, `docs/user-stories.md`, ADR-001
  - **Acceptance Criteria**: Users can log in, navigate between views according to RBAC roles, and access accessible UI components.
  - **Required Tests**: Component unit tests and accessibility checks (WCAG 2.1 AA).
  - **Definition of Done**: Frontend shell operational and communicating with backend API.

- **Task H3a: Implement Creator Authoring Studio UI**
  - **Phase**: Phase H (API/Frontend)
  - **Prerequisites**: Task H2, Task H1b
  - **Ownership**: `src/web/src/pages/creator/authoring/`
  - **File Scope**: Creator studio authoring UI views and API hooks
  - **Objective**: Build interactive frontend views for creating and editing draft worlds, scenes, and narrative nodes.
  - **Traceability**: `docs/user-stories.md`, `docs/vision.md`
  - **Acceptance Criteria**: Creators can author, save, and manage draft world graphs via intuitive UI forms.
  - **Required Tests**: Component unit tests and client interaction tests.
  - **Definition of Done**: Creator authoring studio UI fully functional.

- **Task H3b: Implement Creator Publishing & Validation UI**
  - **Phase**: Phase H (API/Frontend)
  - **Prerequisites**: Task H3a
  - **Ownership**: `src/web/src/pages/creator/publishing/`
  - **File Scope**: Publishing review UI views and validation feedback components
  - **Objective**: Build frontend views enabling creators to trigger publishing graph validation and publish verified world snapshots.
  - **Traceability**: `docs/user-stories.md`, `docs/automation-design.md`
  - **Acceptance Criteria**: Creators can view validation results and successfully publish verified worlds.
  - **Required Tests**: Component unit tests for publishing triggers and error feedback.
  - **Definition of Done**: Creator publishing and validation UI fully functional.

- **Task H3c: Implement Reader Narrative Choice Progression UI**
  - **Phase**: Phase H (API/Frontend)
  - **Prerequisites**: Task H2, Task H1a, Task F1
  - **Ownership**: `src/web/src/pages/reader/`
  - **File Scope**: Reader gameplay UI views and choice selection components
  - **Objective**: Build reader gameplay UI displaying rendered scene text, available choices, and session state variables.
  - **Traceability**: `docs/user-stories.md`, `docs/vision.md`
  - **Acceptance Criteria**: Readers can start sessions, read narrative text, make choices, and observe state updates seamlessly.
  - **Required Tests**: Component unit tests and reader interaction simulation tests.
  - **Definition of Done**: Reader narrative choice progression UI fully functional.

---

### Roadmap Phase I: AI & Media Gateway Integration (Boundaries & Optional Adapters)
- **Task I1: Implement `IntfAIGateway` and `IntfMediaGateway` Port Interfaces & Deterministic Fallbacks**
  - **Phase**: Phase I (AI/Media Gateways)
  - **Prerequisites**: Task H1a, Task H1b
  - **Ownership**: `src/modules/intelligence/domain/ports/` & `infrastructure/`
  - **File Scope**: Gateway port contracts, mock/fallback adapters, provider-neutral external client wrappers
  - **Objective**: Implement AI and media gateway port abstractions ensuring auxiliary intelligence cannot mutate Published Canon or Reader State directly (ADR-006).
  - **Traceability**: `docs/intelligence-design.md`, ADR-006
  - **Acceptance Criteria**: Gateway boundaries strictly enforced; fallback mechanisms handle AI service unreachability gracefully without mandatory provider commitments.
  - **Required Tests**: Unit and integration tests verifying gateway contracts and non-authoritative isolation.
  - **Definition of Done**: AI and media gateway boundaries fully established.

---

### Roadmap Phase J: Final Quality, Integration & CI/CD Pipeline Verification
- **Task J1a: Implement GitHub Actions CI Workflow Configuration**
  - **Phase**: Phase J (Testing & CI/CD)
  - **Prerequisites**: Task H3c, Task I1
  - **Ownership**: CI workflow configuration
  - **File Scope**: GitHub Actions workflow file (`.github/workflows/ci.yml`)
  - **Objective**: Create GitHub Actions CI workflow configuration to automate build, lint, and test execution on push and pull requests (ADR-010).
  - **Traceability**: `docs/testing-strategy.md`, ADR-010
  - **Acceptance Criteria**: Workflow file successfully configured with Node.js setup, dependency install, linting, and test scripts.
  - **Required Tests**: YAML syntax validation and local action dry-run.
  - **Definition of Done**: CI workflow file operational in repository.

- **Task J1b: Execute System-Wide Integration & Test Suite Verification in CI Environment**
  - **Phase**: Phase J (Testing & CI/CD)
  - **Prerequisites**: Task J1a
  - **Ownership**: `tests/`
  - **File Scope**: Vitest test suites, PostgreSQL Testcontainers configuration
  - **Objective**: Execute full Vitest unit and Testcontainers integration test suites in automated headless CI environment.
  - **Traceability**: `docs/testing-strategy.md`, ADR-009, ADR-010
  - **Acceptance Criteria**: Complete test suite passes with 0 failures in automated CI pipeline.
  - **Required Tests**: Full headless test suite run (Unit + Integration tests).
  - **Definition of Done**: CI test pipeline green and verified.

---

### Roadmap Phase K: Deployment, Containerization & Operations
- **Task K1: Implement Production Dockerfile & Local Docker Compose Orchestration**
  - **Phase**: Phase K (Deployment)
  - **Prerequisites**: Task J1b
  - **Ownership**: Root container config
  - **File Scope**: Production Dockerfile, local docker-compose configuration
  - **Objective**: Package modular monolith into optimized production container and provide local multi-container development setup (ADR-010, ADR-011).
  - **Traceability**: `docs/operations.md`, ADR-010
  - **Acceptance Criteria**: `docker-compose up` spins up application and PostgreSQL successfully with zero errors.
  - **Required Tests**: Container build verification and automated health check smoke test.
  - **Definition of Done**: Production containerization and deployment configuration complete.

---

## 3. Post-MVP Implementation Backlog (Deferred / Future Extensions)
- **Task L1: Implement Pluggable Background Job Queue (`IntfJobQueue`)**: Abstracted via `src/shared/ports/job-queue.interface.ts` (BullMQ / Redis per ADR-005) for asynchronous batch simulations. (*Deferred to Post-MVP*).
- **Task M1: Implement Advanced Agent Simulation & Multiverse Branching**: Future living world multi-timeline outcome pooling and Overseer override engine. (*Deferred to Post-MVP*).
