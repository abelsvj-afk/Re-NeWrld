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

- **Task E0: Complete Draft Schema for Publishing (start scene designation + ending flag mapping)**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task D2
  - **Ownership**: `db/migrations/`, `src/modules/world/domain/`
  - **File Scope**: `db/migrations/004_publishing_markers.sql` (new), `src/modules/world/domain/entities/scene.entity.ts`, `src/modules/world/domain/entities/world.entity.ts`, repository mappers
  - **Objective**: Close the two audit gaps. (1) `worlds.start_scene_id`: genuinely missing — add the column (nullable until set) with a **same-world composite FK** `(start_scene_id, world_id) REFERENCES scenes(scene_id, world_id) ON DELETE RESTRICT`, following the existing `fk_choice_target_scene` pattern and reusing `unique_scene_per_world`. A plain FK to `scenes(scene_id)` would permit pointing at another world's scene. (2) `scenes.is_ending`: the **column already exists** in migration 001 — do NOT re-add it (that would fail the migration). The `Scene` entity was verified to already expose `isEnding`; no scene persistence layer exists yet, so no scene mapper changes were required. Implements `detailed-design.md:63`'s `ending: true`; invents no new schema.
  - **Traceability**: `docs/detailed-design.md`, ADR-013 §3 (corrected 2026-10-13)
  - **Acceptance Criteria**:
    - Migration 004 adds only `worlds.start_scene_id` plus the composite FK constraint; it does not touch `scenes.is_ending`.
    - Setting `start_scene_id` to a scene from a different world is rejected by the database.
    - Scene entity exposes `isEnding` (verified; no scene persistence layer exists, so no scene mapper changes). World repository round-trips preserve `startSceneId`.
    - Publishing (E2a) rejects worlds with no start scene set (blocker per ADR-013 §5).
  - **Required Tests**: Unit tests for entity validation; repository mapper round-trip tests; integration test asserting cross-world `start_scene_id` is rejected (Testcontainers — UNVERIFIED until Docker/CI runs it).
  - **Definition of Done**: Markers present and enforced, migration runs cleanly on a fresh database, no duplicate-column failure.

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
  - **Objective**: Validate structural references: every choice's target scene exists (dangling target = blocker). Condition/mutation *semantic* reference validation is explicitly out of scope — conditions are opaque JSON until the G1 grammar lands (Decision: Option A, 2026-10-13 — documented limitation, ADR-013 §5: a condition referencing a nonexistent item/flag/character can pass publishing and fail later; G1 must define semantic validation and its failure behavior, and the runtime must handle invalid references safely).
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
  - **Approved design (2026-10-13)**:
    - `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger `trg_canon_snapshots_immutable` on `published_canon_snapshots`, backed by function `reject_canon_snapshot_mutation()` (plpgsql). Rejects every column's UPDATE and every DELETE before the row changes; INSERTs untouched.
    - Error contract: `RAISE EXCEPTION ... USING ERRCODE = 'P0001'` with a diagnostic message naming the operation (`TG_OP`) and `snapshot_id`. Tests assert the SQLSTATE and a stable message fragment, not the whole message.
    - Migration `005_canon_immutability.sql` is up-only and filename-ordered (001–004 convention): `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`/`CREATE TRIGGER`. Fresh DB: clean run. Existing DB: effective immediately, no backfill. Removing the trigger later would be a new migration.
    - Boundary (documented in the migration header): TRUNCATE is not intercepted — row triggers do not fire on TRUNCATE and the trigger must not be claimed to prevent it. This guard protects against accidental application-level mutation; it is not a defense against privileged database users (who can alter triggers or run privileged operations). The application role genuinely lacks TRUNCATE privileges.
  - **Traceability**: ADR-013 §4 (D1)
  - **Acceptance Criteria**:
    - Migration 005 creates the trigger; fresh-database migration run is clean.
    - Direct UPDATE/DELETE against snapshots raises; the error surfaces, never swallowed.
    - Application repository exposes no update/delete method for snapshots (port-surface test).
    - **Refinement 1**: integration test recovers the transaction (rollback or savepoint) after each rejected statement — PostgreSQL marks a transaction failed after an uncaught statement error, and the test must not obscure the trigger behavior.
    - **Refinement 2**: the prototype regression test is supplementary only — the PostgreSQL integration tests are the authoritative enforcement tests.
  - **Required Tests**: Integration test executing raw INSERT (succeeds), UPDATE (whole-row and single-column) and DELETE (both rejected with P0001) — Testcontainers, UNVERIFIED until Docker/CI runs it; unit test asserting the port has no mutating methods beyond insert.
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
  - **Traceability**: `docs/runtime-design.md` §4, ADR-013 §4 (D2), ADR-014 §4 (D3)
  - **Acceptance Criteria**:
    - Entity enforces invariants: session references a snapshot (never a mutable draft), state map is JSON-serializable, version increments only via `applyTransition`.
    - Illegal transitions (e.g., `completed → active`) throw typed domain errors.
    - Legal transitions exactly: `active → completed`, `active → abandoned` (ADR-014 D3). Terminal states are absorbing — no outgoing transitions; terminal sessions remain readable via GET but cannot be transitioned or mutated. `completed` only via terminal ending; `abandoned` only via explicit reader close.
  - **Required Tests**: Unit tests — invariant violations, transition rules, version increment.
  - **Definition of Done**: Domain core fully tested and isolated from infrastructure.

- **Task F1b: Implement Session Initialization Use Case**
  - **Phase**: Phase F (Reader Runtime)
  - **Prerequisites**: Task F1a
  - **Ownership**: `src/modules/session/application/` (exists as empty scaffolding)
  - **File Scope**: `start-reader-session.use-case.ts` (new), `findLatestByWorldId` on `CanonRepositoryPort` + `PostgresCanonRepository` (new), unit tests with fakes
  - **Objective**: Start a new playthrough: resolve the world's latest published snapshot (error if none published), create the session pinned to that `snapshot_id` with `currentSceneId` = canon start scene and empty initial state. Multiple sessions per reader per world allowed (ADR-013 D2) — no uniqueness constraint beyond the primary key.
  - **Traceability**: US-R01, `docs/runtime-design.md` §4, ADR-014 §2–§3 (D1, D2)
  - **Acceptance Criteria**:
    - World with no published snapshot → typed error (HTTP 409 with clear message at the route layer).
    - Session row references the latest snapshot version at creation time; later publishes do not move it.
    - Error cases: unknown world (404), unpublished world (409).
    - `findLatestByWorldId(worldId)`: returns the highest-`version_number` snapshot (never derived from `worlds.status`); `null` when never published → `NoPublishedSnapshotError` → 409. `canon_data` validated against `CanonDataSchema` on read; corrupt latest snapshot → typed `CorruptCanonSnapshotError` → 500 — never silently fall back to an older version (ADR-014 D1).
    - Owner is derived exclusively from the authenticated session (`request.user.userId`); the client never supplies it. Concurrent creates all succeed as independent sessions; no idempotency-key enforcement (deferred to Phase G).
  - **Required Tests**: Unit tests with fakes — happy path, no-snapshot error, snapshot pinning across a subsequent publish.
  - **Definition of Done**: Session initialization logic verified independent of HTTP.

- **Task F1c: Implement Session HTTP Routes (reader-owned)**
  - **Phase**: Phase F (Reader Runtime)
  - **Prerequisites**: Task C3, Task F1b
  - **Ownership**: `src/modules/session/http/` (new), `src/app.ts`
  - **File Scope**: `src/modules/session/http/session.routes.ts` (new), `src/modules/session/application/get-reader-session.use-case.ts` (new), `src/app.ts` (register + `sessionRepository` dep), route tests
  - **Objective**: `POST /worlds/:id/sessions` (create playthrough; any authenticated reader), `GET /sessions/:id` (owner-only; 404-not-403 for other readers' sessions, mirroring world route conventions). Session cookie auth via existing middleware; `requireReader` (kept deliberately for this phase) gates creation. Routes are unprefixed, following the implemented E2b convention (`docs/runtime-design.md`'s `/api/v1` prefix is aspirational — ADR-014 §7).
  - **Traceability**: US-R01, US-R05, ADR-003 (Zod validation), ADR-014 §3 (D2), ADR-014 §9 (Batch 2 design)
  - **Acceptance Criteria**:
    - 201 with `{ sessionId, snapshotId, versionNumber, currentSceneId, status }` on create; 409 when the world has no published snapshot.
    - Cross-reader access returns 404 (not 403 — no existence oracle), unauthenticated returns 401.
    - Zod-validated bodies; invalid payloads → 400.
    - Ownership check lives in `GetReaderSessionUseCase` (404 on missing-or-not-owned) — routes stay thin, no duplicated authorization logic. `readerId` derived exclusively from `request.user.userId`.
    - F1b touch-up (additive): `StartReaderSessionResult` gains `snapshot: CanonSnapshot` so the route can return `versionNumber` without a second query., ADR-014 §3 (D2)
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
  - **Traceability**: `docs/runtime-design.md` §3, ADR-002, ADR-014 §5 (D4), ADR-014 §9 (Batch 2 design)
  - **Acceptance Criteria**:
    - State mutation and timeline append commit atomically; induced failure mid-transaction rolls back both.
    - Concurrent conflicting writes → one wins, the other gets 409 (version mismatch).
    - Timeline `sequence_number` is gapless per session (unique constraint enforced).
    - No code path issues UPDATE/DELETE against `reader_timelines` or `published_canon_snapshots`.
    - Optimistic-locking contract (ADR-014 D4): every state-changing operation takes `expectedVersion`; inside one transaction, `SELECT ... FOR UPDATE` the session row, compare versions — mismatch → typed `SessionVersionConflictError` → HTTP 409 (response includes the current version for client re-sync) and ROLLBACK with zero partial writes; match → apply state diff, INSERT timeline row, `version + 1`, COMMIT.
    - `PostgresSessionRepository.applyTransition({ sessionId, expectedVersion, toSceneId, stateDiff, choiceId }, tx?)`: rehydrates the `ReaderSession` entity and delegates the transition to `entity.applyTransition` — the repository never bypasses the entity or duplicates transition logic; it contributes SQL + the single transaction only (joins the passed `tx` or manages its own via `withTransaction`). `SessionVersionConflictError` carries `report = { currentVersion }`, surfaced by the existing 4xx `report` envelope (E2b precedent; no handler changes).
    - Transaction ownership (ADR-014 §10.3): `tx?: pkg.PoolClient` matches the existing port convention. Caller-supplied `tx` → repository issues statements only, never BEGIN/COMMIT/ROLLBACK. No `tx` → repository wraps in the existing `withTransaction` helper. No parallel transaction abstraction.
    - Sequence semantics (ADR-014 §10.4): "gapless" = no missing `sequence_number` among *committed* entries per session. Allocated as `MAX(sequence_number)+1` inside the transaction while holding the session row's `FOR UPDATE` lock (NOT a PG sequence generator — those burn values on rollback). `UNIQUE(session_id, sequence_number)` is the backstop; any slipped race fails the insert and rolls back everything.
  - **Required Tests**: Integration tests with Testcontainers simulating commit, rollback on failure, and concurrent version conflicts — **UNVERIFIED until Docker/CI runs them** (no Docker in this environment); unit tests for the diff-application logic with fakes.
  - **Definition of Done**: Atomicity guarantees verified; Docker-dependent tests explicitly marked UNVERIFIED, never claimed passing.
  - **System Completeness Gate (slice)**: Security — session ownership enforced at repository level (reader_id predicate on every query); Reliability — transaction boundaries + rollback; Data Governance — timeline append-only, state minimization (only gameplay variables, no PII); AI Safety — N/A (deterministic persistence, no model involvement).

---

- **Task F3: Session abandon endpoint (ADR-015 §9.4 follow-up — tracked 2026-10-14)**
  - **Phase**: Phase F (Reader Runtime) — follow-up
  - **Prerequisites**: F1c, F2a
  - **Ownership**: `src/modules/session/http/session.routes.ts`, `src/modules/session/application/`
  - **File Scope**: New route + use case (or entity-delegated handler); `ReaderSession.abandon()` entity method already exists
  - **Objective**: `POST /sessions/:id/abandon` — reader-initiated session abandonment per ADR-015 §9.4 (explicitly deferred out of G2 scope). Absorbing terminal state: `active → abandoned`; idempotent on already-abandoned/completed.
  - **Traceability**: ADR-015 §9.4
  - **Acceptance Criteria**:
    - Authenticated owner only (404-not-403 for non-owners, per session ownership convention).
    - Terminal states absorbing: abandoning an `abandoned`/`completed` session is a no-op success, not an error.
    - Timeline entry appended for the abandonment transition.
    - Optimistic-locking 409 contract honored if version supplied.
  - **Required Tests**: Unit tests (entity transition, idempotent re-abandon, ownership); integration test UNVERIFIED until Docker/CI.
  - **Definition of Done**: Route live, tests green, docs updated. Not started.

---

### Roadmap Phase G: Deterministic Narrative Execution
- **Design gate**: ADR-015 **APPROVED** 2026-10-13 (product owner). 8 review rounds, findings B1–B38 + C1–C3 all resolved. Level 3 change. No implementation until this approval — now authorized.
- **Implementation status 2026-10-14**: ACCEPTED (commit c4b85ae; merged PR #2 b9b215a). All Phase G tasks implemented per ADR-015. **G1a** (`src/modules/world/domain/services/grammar.schema.ts`, `semantic-validator.ts`, `grammar-marker.ts` — grammar lives in world module per repository-architecture strict isolation; session→world is the established direction), **G1b** (`src/modules/session/domain/services/condition-evaluator.ts`, `mutation-applier.ts`; `choice.errors.ts` taxonomy), **G1c** (E1b extended; Choice entity preserves absent vs `{}`; canon schema marker; migration 007 nullable payloads), **G2a** (migration 006, fingerprint, idempotency repo), **G2b** (`applyChoiceResult`, terminal/idempotency errors), **G2c** (17-step use case + D3a), **G2d** (route + error mapping), **G2e** (timeline-consumer inventory: no production readers — closed). Verification 2026-10-14: tsc clean (backend + frontend); 302/302 unit tests pass (33 files); 46 integration tests exist but UNVERIFIED here (no Docker); 100% G1 line/branch coverage claimed per ADR-015 gate (not re-verified in this pass); p95 30.6ms per prior report (no retained benchmark artifact).
- **Task G1a: Grammar Schemas + Semantic Validator + Marker Helper (pure domain)**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: ADR-015 approved
  - **Ownership**: `src/modules/session/domain/services/` (new files)
  - **File Scope**: `grammar.schema.ts` (Zod discriminated unions for Condition/Mutation per ADR-015 §2), `semantic-validator.ts` (publish-time walker), `grammar-marker.ts` (`hadMarker`/`effectiveVersion` helper, B12)
  - **Objective**: Implement the versioned tagged-object grammar: condition ops (`and`/`or`/`not`/`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`has`/`in`), mutation ops (`set`/`inc`/`dec`/`toggle`/`unset`); operand types; `var` rules (non-empty, ≤128 chars, flat, reject `__proto__`/`constructor`/`prototype` per C3); non-empty `and`/`or`; absent `conditions` = unconditional; `{}` rejected; absent `mutations` ≡ `[]`; nesting limits (depth 10, 100 nodes, 50 mutations); finite numerics; marker `condition_grammar_version: z.literal(1).optional()` with NO schema default.
  - **Traceability**: ADR-015 §2, D1a; FR-04; US-C05
  - **Acceptance Criteria**: All §2 grammar rules enforced; unknown op/malformed shape/overlong var/excessive nesting/non-finite literal/empty boolean array/`{}` conditions/`__proto__` keys rejected; valid grammars pass; marker presence tracked separately from default.
  - **Required Tests**: Unit tests for every rule + boundary (100% coverage gate per ADR-015 §8).
  - **Definition of Done**: Schemas + validator + marker helper implemented, 100% line/branch/function/statement coverage.
- **Task G1b: Condition Evaluator + Mutation Applier (pure domain)**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Task G1a
  - **Ownership**: `src/modules/session/domain/services/` (new files)
  - **File Scope**: `condition-evaluator.ts`, `mutation-applier.ts`, error classes (`CanonInvariantError`, `LegacyPayloadRejectedError`, `MutationApplicationError`, `StateInvariantError` — B24/B37)
  - **Objective**: Pure, deterministic, total evaluation: conditions never throw on data shape (missing var → false, type mismatch → false); two-phase mutation boundary (Phase 1 parse → marker-dependent policy: 500 marked / 422 legacy; Phase 2 applicability → 422 per-op table); applier works on deep copy, returns `{state, applied}` only on full success; `unset` reports `removed: boolean`; non-finite `by` = parse failure, non-finite result = 422; negative finite `by` allowed; legacy `{}` → unconditional; legacy unparsable → fail closed.
  - **Traceability**: ADR-015 D1a, D1b; FR-08, FR-09; US-R03
  - **Acceptance Criteria**: Truth tables for all ops; per-op missing-var table; discriminated `appliedMutations`; determinism (byte-identical repeats, no Math.random/Date/coercion); error-type separation preserved.
  - **Required Tests**: 100% coverage (line+branch+function+statement) incl. parsers, marker helper, policy boundary (B29); performance benchmark (<10ms at max bounds).
  - **Definition of Done**: Evaluator + applier + error classes implemented, coverage gate met, benchmark passing.
- **Task G1c: E1b Publish-Time Semantic Validation Extension**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Task G1a
  - **Ownership**: `src/modules/world/domain/services/graph-validator.ts` (additive)
  - **File Scope**: Extend E1b validator with G1 semantic checks
  - **Objective**: Walk every choice's conditions/mutations at publish time: unknown op, malformed shape, non-string/empty/overlong `var`, `__proto__` keys, nesting beyond §2 limits, non-finite literals, empty `and`/`or`, `{}` conditions → publishing blockers (422, FR-05 taxonomy). Absent `mutations` valid. Existing E1a/E1b tests unmodified.
  - **Traceability**: ADR-015 §10 consequences; FR-05
  - **Acceptance Criteria**: Each violation class blocks publishing with the correct error; valid grammars pass; legacy snapshots unaffected (publish-time only applies to new publishes).
  - **Required Tests**: Unit tests per violation class.
  - **Definition of Done**: E1b extended, all existing + new tests pass.
- **Task G2a: Migration 006 + Idempotency Repository + Fingerprint Helper**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Task G1b
  - **Ownership**: `db/migrations/`, `src/modules/session/infrastructure/persistence/`, `src/modules/session/domain/`
  - **File Scope**: `006_idempotency_keys.sql`, `IdempotencyRepositoryPort` + Postgres impl, `fingerprint.ts` (canonical SHA-256, B35 test vectors)
  - **Objective**: `idempotency_keys` table (UUID PK, session_id FK CASCADE, request_hash CHAR(64), response JSONB, created_at, expires_at; index on expires_at). Expiry predicate `expires_at <= now()` on DB clock everywhere (B34). Fingerprint: exact canonical bytes per ADR-015 step 2 + 3 normative test vectors. Refinement requirement (B32): specify isolation level (default READ COMMITTED) + exact reclamation SQL; verify via PG tests.
  - **Traceability**: ADR-015 §7 (D6); ADR-013 D3
  - **Acceptance Criteria**: Migration applies cleanly; fingerprint matches all 3 test vectors; reclamation protocol per §7.
  - **Required Tests**: Unit tests for fingerprint (vectors, casing, ordering); integration tests for migration + reclamation races (B27).
  - **Definition of Done**: Migration + repo + fingerprint implemented and tested.
- **Task G2b: Entity applyChoiceResult + Error Classes**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Task G1b
  - **Ownership**: `src/modules/session/domain/entities/reader-session.entity.ts` (additive), `src/modules/session/domain/errors/`
  - **File Scope**: `applyChoiceResult(toSceneId, newState, { isEndingTarget })`, new error classes
  - **Objective**: Atomic domain operation: active-check, `newState` vs `SessionStateSchema` (`StateInvariantError` → 500 on failure), wholesale state replacement (defensive copy), scene set, version +1 exactly once, `updatedAt`, status derived from `isEndingTarget` (B23). F2a `applyTransition` untouched. New errors: `CanonInvariantError` (500), `LegacyPayloadRejectedError` (422), `MutationApplicationError` (422), `StateInvariantError` (500), `StoredResponseCorruptError` (500), `ChoiceNotAttachedError` (422), `ChoiceNotAvailableError` (422, exists? verify).
  - **Traceability**: ADR-015 D1b, D4
  - **Acceptance Criteria**: Single version increment; terminal completion derived; invalid state → 500 pre-write; F2a tests unmodified and passing.
  - **Required Tests**: Unit tests for the new method + error mappings.
  - **Definition of Done**: Entity method + errors implemented, tested, F2a intact.
- **Task G2c: SubmitChoiceUseCase (17-step flow)**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Tasks G2a, G2b
  - **Ownership**: `src/modules/session/application/`
  - **File Scope**: `submit-choice.use-case.ts` (new)
  - **Objective**: Implement ADR-015 D3 steps 1–17 exactly: auth/ownership (404-not-403), idempotency-key validation + fingerprint, early lookup (read-only), terminal fast-path, canon load (corrupt → 500), choice existence (404 pre-tx), tx: row lock → idempotency recheck (replay/409/expired-delete-in-tx) → active check → version check (409 + currentVersion) → placement check (422, B30) → conditions (422/500 marker-dependent) → mutations in-memory (two-phase) → `applyChoiceResult` → response construction in-memory (availableChoices: [] if ending; B16 policy otherwise) → persist (UPDATE incl. status + timeline envelope INSERT + idempotency INSERT) → COMMIT → D3a recovery on unique violation (rollback-first, replay/409/bounded retry, no recursion). Discard mutated entity on rollback (B26).
  - **Traceability**: ADR-015 D3, D3a, D5; FR-08, FR-09; US-R03
  - **Acceptance Criteria**: Every step's error contract per D4; zero committed writes on all failure paths; idempotency replay deep-equal; version precedence (stale + failing condition → 409).
  - **Required Tests**: Unit tests with fakes (full D7 G2 matrix); integration tests (real PG): happy path, concurrency, idempotency races (B21), expiry+cleanup race (B27), construction failure (B28), legacy snapshots.
  - **Definition of Done**: Use case implemented, all unit + integration tests pass.
- **Task G2d: POST /sessions/:id/choices Route + Error Mapping + Wiring**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Task G2c
  - **Ownership**: `src/modules/session/http/session.routes.ts` (additive), `src/app.ts` (error handler additive)
  - **File Scope**: Route, Zod schemas (body: choiceId UUID + expectedVersion positive int, strict; header X-Idempotency-Key UUID required), error mapper
  - **Objective**: `POST /sessions/:id/choices`, unprefixed; `authenticate` + reader ownership (404-not-403); exact D2 response schema (appliedMutations discriminated, availableChoices choiceId/text/sortOrder only, no stateVariables); error mapping preserves B24 classes (route-level test: marked parse → 500, legacy parse → 422, applicability → 422); DI wiring in `SessionRouteDeps`/`AppDeps`.
  - **Traceability**: ADR-015 D2, D4; ADR-003
  - **Acceptance Criteria**: All status codes per D4; spoilers never exposed; error-type boundary preserved end-to-end.
  - **Required Tests**: Route unit tests (fakes); error-mapper test (B24).
  - **Definition of Done**: Route implemented, wired, tested.
- **Task G2e: Timeline Consumer Inventory Closure**
  - **Phase**: Phase G (Deterministic Engine)
  - **Prerequisites**: Task G2c
  - **Ownership**: repo-wide
  - **File Scope**: verification only (no code unless a consumer is found)
  - **Objective**: (B25) Close the inventory: 2026-10-13 search found NO production readers of `reader_timelines.state_diff` (write-only audit column; only test assertions read it). Re-verify at implementation time; if any reader is found, add both-shapes test or documented justification.
  - **Definition of Done**: Inventory re-verified and recorded.
- **System Completeness Gate (Phase G slice)**: Security — ownership 404-not-403, strict Zod at boundaries, parameterized SQL, no secrets; Abuse — idempotency prevents duplicate mutations, rate limits already global (threat model: Planned); Reliability — transactions + rollback, D3a bounded recovery, no silent failures; Data Governance — 24h idempotency retention with `expires_at <= now()` predicate, CASCADE defensive (no session deletion in MVP); AI Safety — N/A (pure deterministic logic, no model involvement — ADR-015 §2); Product Completeness — N/A (backend phase; frontend is Phase H).

---

### Roadmap Phase H: API & Frontend Integration

- **Task H-UX1: Become-a-Creator self-service upgrade (Slice 1)** [APPROVED 2026-10-15]
  - **Phase**: Phase H (API/Frontend) — Level 2
  - **Prerequisites**: `POST /auth/become-creator` exists (verified idempotent, per-request role resolution)
  - **File Scope**: `src/web/src/lib/api.ts`, `src/web/src/stores/auth.ts`, `src/web/src/pages/ReaderPage.tsx`
  - **Objective**: Reader accounts get a "Become a Creator" button calling the existing endpoint; auth store updates on success; redirect to Creator Studio without re-login.
  - **Acceptance Criteria**: Button visible only for `role === 'reader'`; success → role becomes `'creator'` → CreatorDashboard renders; already-creators unaffected (endpoint idempotent); unauthenticated → 401 (existing backend behavior).
  - **Required Tests**: Unit test for auth-store upgrade action; backend `become-creator.use-case` already covered.
  - **Definition of Done**: User's account can enter Creator Studio without re-registering. Live UX Gate on deployed URL.

- **Task H-UX2: Published-world catalog with genre/tag taxonomy (Slice 2)** [APPROVED 2026-10-15]
  - **Phase**: Phase H (API/Frontend) — Level 2 (no migration: genre/tags in existing metadata JSONB; no auth-boundary change; new read endpoint within existing architecture)
  - **Prerequisites**: Task H-UX1
  - **File Scope**: `src/modules/world/domain/value-objects/world-schemas.ts`, `src/modules/world/application/list-published-worlds.use-case.ts` (new), `src/modules/world/domain/ports/world.repository.port.ts`, `src/modules/world/infrastructure/persistence/postgres-world.repository.ts`, `src/modules/world/http/world.routes.ts`, `src/web/src/lib/api.ts`, `src/web/src/pages/ReaderPage.tsx`, world create/edit forms
  - **Objective**: Reader-accessible paginated catalog of published worlds across creators, with genre (closed enum of 10 + 'other') and tags (validated freeform). Creator can assign at create/edit. Reader can filter by genre/tag/search.
  - **Acceptance Criteria**: `GET /worlds/published` returns only published worlds, any authenticated role; drafts excluded; invalid genre → 400; genre/tag/search filters combine; search applied before pagination; deterministic ordering (publishedAt desc, id tiebreak); existing worlds without genre/tags appear under "All"/"Uncategorized"; no creator display name in MVP (UUID not exposed).
  - **Required Tests**: Unit (filter logic, schema validation, pagination); integration (multi-creator draft/published matrix) — CI only.
  - **Definition of Done**: Reader library shows published worlds from all creators with working genre/tag/search filters. Live UX Gate on deployed URL.
  - **System Completeness Gate (2026-10-15)**: Security — new endpoint authenticated (any role), no RBAC change; search uses parameterized queries; genre validated against closed enum; global rate limits apply; Abuse — pagination bounded 1–100, deterministic ordering; Reliability — no migration, no schema change; Data Governance — no creator PII exposed (UUID not shown, display name omitted per decision); drafts excluded at query layer; AI Safety — N/A (deterministic catalog, no model involvement).

- **Task H-UX3: Creator/Reader view switching (Slice 3)** [APPROVED 2026-10-15]
  - **Phase**: Phase H (API/Frontend) — Level 2 (frontend-only; no backend changes; no auth-boundary change; role and permissions untouched)
  - **Prerequisites**: Task H-UX1
  - **File Scope**: `src/web/src/lib/view-mode.ts` (new), `src/web/src/components/ViewToggle.tsx` (new), `src/web/src/router.tsx`, `src/web/src/pages/CreatorDashboard.tsx`, `src/web/src/pages/ReaderPage.tsx`
  - **Objective**: Creator accounts can switch between Creator Studio and Reader View without changing their account role. Preference persists in localStorage. Reader-only accounts never see the toggle.
  - **Acceptance Criteria**: Toggle visible only for `role === 'creator'`; switching updates preference + navigates; `/` redirects creators with reader-preference to `/read` (one-way, no loops); explicit `/creator` navigation always shows studio; corrupted localStorage values fall back to role default; refresh preserves view.
  - **Required Tests**: Unit tests for view-mode helpers (get/set/validation/clear).
  - **Definition of Done**: Creator can toggle views, refresh safely, no redirect loops. Live UX Gate on deployed URL.
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

## 4. Technical Debt Register (STOP-5)
- **H-facade**: ✅ COMPLETE 2026-10-14 — All 22 pre-existing deep imports migrated to `src/modules/world/application/index.ts` facade. Boundary test allowlist emptied; test now enforces zero deep `world/domain` imports.
- **H-idempotency-janitor**: ✅ COMPLETE 2026-10-14 — `PostgresIdempotencyRepository.deleteExpired()` wired into the hourly janitor in `src/server.ts` alongside session and password-reset cleanup.

## 5. Deferred UI/UX Items — DO NOT FORGET (user directive 2026-10-14)
The following were explicitly deferred from Phase H MVP but the user requires them tracked permanently. Any agent working on frontend MUST consult this list before declaring UI work "complete." Source: user mockups (10 images, 2026-10-14) + `docs/proposed-creator-studio-ai-assistant-vision.md`.
- **H-UI-polish**: Cinematic polish effects — glowing timeline nodes, animated particle backgrounds, glow-on-hover for cards, smooth scene-transition animations (Framer Motion). Deferred for MVP; layout/typography/color-system come first.
- **H-UI-codex**: Character Codex UI — character profiles with tabs (overview/skills/biography), relationship webs, faction displays, world discoveries panel. Backend data exists; UI is post-MVP.
- **H-UI-timeline-engine**: Chrono-Narrative Engine UI — branching timeline visualization with paths (e.g. Alliance vs Betrayal), node detail panels, consequence displays. Requires React Flow.
- **H-UI-analytics**: Creator analytics dashboard — reader drop-off rates, popular choice paths, completion analytics (US-P04). Post-MVP.
- **H-UI-world-bible**: Full World Bible UI — connected canon/lore/character/location/faction browser with cross-referencing (per Creator Studio vision §4). Post-MVP.
- **H-UI-graph-advanced**: Advanced branching graph visualizer with simulation overlay — interactive scene/choice graph with path highlighting, dead-end detection display (US-C13). Post-MVP.
- **H-UI-lore-inspection**: In-text lore keyword inspection — tappable lore terms within reading prose revealing world entries without breaking flow (US-R07). Post-MVP.
- **H-UI-character-dialogue**: Character dialogue recall & journal view — past conversations and relationship milestones (US-R08). Post-MVP.
- **H-UI-replay**: Replay & alternate path exploration — chapter checkpoints for exploring alternate choices (US-R10). Future.
- **H-UI-ai-assistant**: Governed Creator AI writing assistant with Consult/Prepare/Execute/Autopilot permission tiers (per Creator Studio vision §2-3, US-C15). Future — depends on prompt-injection defense framework.
- **H-UI-collab**: Collaborative multi-author workspace with granular role permissions (US-C16). Future.
- **H-UI-monetization**: Creator subscriptions, premium chapters, monetization tools (US-P03). Future — depends on payment gateway decisions.
- **H-UI-social**: Creator profiles, follows, ratings/reviews, story recommendations (US-P01, US-P02). Future.
- **H-UI-mobile**: Companion mobile apps with offline reading + sync (vision §4 post-MVP). Future.
- **H-UI-tts**: Audio TTS narration and dynamic generated scene illustrations (vision §4 post-MVP). **PULLED FORWARD 2026-10-15** — Phase 21: ADR-016 (scene narration via ElevenLabs, v1 single narrator) approved by product owner; System Completeness Gate §8 evaluated PASS. Illustrations remain Future.
  - **T1 (backend)**: `scene_narrations` migration; narration service (ElevenLabs proxy, content-hash cache, quota checks, circuit breaker); `POST /worlds/:id/scenes/:sceneId/narration` (creator), `GET` audio serve, `GET /worlds/:id/narration/quota` (creator).
    - AC: generation triggered once per content hash; concurrent first-reads converge on one synthesis; quota exhausted → 402, reading unaffected; key never leaves server.
  - **T2 (frontend)**: reader playback UI (play/pause + waveform progress, dark-cinematic, keyboard-accessible); creator voice picker with preview + per-scene "Generate" + quota bar; scene-list narration status icons.
    - AC: Live UX Verification Gate (AGENTS.md §6) on the deployed URL; product-owner visual sign-off.
  - **T3 (tests)**: unit (hash stability, quota logic, idempotent generation), integration (cache hit/miss, 402 path) — ElevenLabs calls mocked; live synthesis verified manually once.
  - Prerequisites: ADR-016 approved ✅; completeness gate §8 PASS ✅; `ELEVENLABS_API_KEY` in env (Secure Vault, never committed).
