# CHANGELOG — Re:NeWrld

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

---

## [Unreleased]

### Added
- Initialized repository structure with Project Growth v1.1.0 governance foundation.
- **Task A2**: Implemented centralized Zod environment validation (`src/config/env.ts`) enforcing strict fail-fast startup checks and comprehensive unit tests (`tests/unit/env.test.ts`).
- **Task A3**: Configured Pino structured JSON logging (`src/shared/logger/pino.logger.ts`) with env-based log level (`env.LOG_LEVEL`), secret redaction, Fastify request ID correlation tracking (`x-request-id`), bounded validation of incoming request IDs, and unit tests (`tests/unit/logger.test.ts`).
- **Task B1**: Established PostgreSQL connection pool infrastructure (`src/shared/database/db.ts`) with `pg`, required PostgreSQL `DATABASE_URL` validation (no credentialed default), `PORT` integer constraint (1–65535), staging `APP_ENV` reconciliation, Node built-in `--env-file` support for development scripts, engines node constraint `>=20.6.0`, testcontainers integration tests (`tests/integration/database.test.ts`) exercising the real B1 pool, explicit failure on Docker/database unavailability unless intentional skip enabled (`SKIP_DB_TESTS=true`), and strengthened logger tests verifying `LOG_LEVEL`.
- **Task B2**: Implemented versioned SQL schema migrations and migration runner (`db/migrations/001_initial_schema.sql`, `scripts/migrate.ts`) adhering to the B2 Design Contract (PostgreSQL 15+, UUID v4 PKs, composite same-world referential integrity, immutable published Canon snapshots, hybrid reader session binding, timeline sequence constraints, advisory locking, and migration integration tests in `tests/integration/migration.test.ts`).
- **Tasks C1/C2**: Authentication foundation — `User` entity with value objects, session-based authentication with secure HttpOnly/SameSite cookies, SHA-256 hashed session tokens (migration 002).
- **Task C3**: Fastify RBAC security middleware and authorization guards.
- **Tasks D1/D2**: Creator world-authoring subsystem — World/Character/Chapter/Scene/Choice domain entities with typed validation errors, authoring use cases, and Postgres persistence.
- Auth HTTP routes: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, plus self-serve `POST /auth/become-creator` (reader → creator, one-way).
- World HTTP routes (creator-only): full CRUD including `DELETE /worlds/:id` with 404-not-403 semantics.
- **Task C4**: Password reset and account recovery (FR-13, ADR-012) — hashed single-use 15-minute tokens (migration 003), Resend email provider behind `EmailServicePort` with console adapter for dev/test, anti-enumeration responses, session revocation on reset.
- **Task E0**: Publishing schema markers — migration 004 adds `worlds.start_scene_id` with same-world composite foreign key; `World.startSceneId` entity field and repository mapping.
- **Task E1a**: Pure graph-reachability validator for publishing (`validateWorldGraph`) — BFS from the designated start scene; unreachable scenes reported as warnings, never blockers.
- **Task E1b**: Structural choice-reference validator (`validateChoiceReferences`) — all dangling targets reported as blocking errors.
- **Task E2a**: Publish use case and snapshot repository — E1a/E1b aggregation with HTTP 422 `PublishingValidationError`, v1 `CanonDataSchema` contract, transaction-scoped per-world advisory locking with version allocation, append-only `published_canon_snapshots`.
- Developer tooling: pre-push git hook running `tsc --noEmit` and unit tests; self-sufficient `npm run test:unit` (inline `APP_ENV=test` + dummy `DATABASE_URL`).
- **Task E2b**: Publish API route — `POST /worlds/:id/publish` (creator-only) in `world.routes.ts`; 201 with `{ snapshotId, versionNumber, warnings }`, 422 with distinguished `{ blockers[], warnings[] }` via new `report` field on the central 4xx error envelope, 404-not-403 ownership semantics; `WorldRouteDeps`/`AppDeps` extended with scene/choice/canon repositories (Postgres defaults wired in `app.ts`).
- **Task E2c**: Canon immutability — migration `005_canon_immutability.sql` adds `BEFORE UPDATE OR DELETE` trigger `trg_canon_snapshots_immutable` on `published_canon_snapshots` (raises P0001; INSERTs unaffected; TRUNCATE/privileged-user boundaries documented); Testcontainers integration tests (insert/update/delete, transaction recovery) + append-only repository surface unit test.
- Phase F design contracts (ADR-014, Proposed): `findLatestByWorldId` snapshot lookup (highest version, null when never published, corrupt \u2192 500 never silent fallback), session init auth/ownership/concurrency, absorbing terminal lifecycle states, optimistic-locking 409 contract, parallel PostgreSQL verification track; F1a/F1b/F1c/F2a task definitions refined. No implementation authorized.
- **Task F1a**: Reader session domain model — `ReaderSession` entity (snapshot pinning, JSON state variables, optimistic-locking version, absorbing `active \u2192 completed | abandoned` lifecycle), `SessionId`/`SessionStatus` VOs, session errors, `SessionRepositoryPort`. **Task F1b**: session initialization use case + `findLatestByWorldId` on the canon port and Postgres impl (highest version, null when never published, corrupt \u2192 500 never silent fallback); 404 unknown world, 409 no snapshot.
- Phase F Batch 2 combined design (ADR-014 \u00a79, Proposed): F1c session routes (`POST /worlds/:id/sessions`, `GET /sessions/:id` with ownership in `GetReaderSessionUseCase`, additive F1b `snapshot` result touch-up) + F2a `PostgresSessionRepository.applyTransition` (entity-delegated transitions, single transaction, 409 with `report.currentVersion`). No implementation authorized.
- Phase F Batch 2 implementation-gate confirmations (ADR-014 \u00a710): verified error-mapping table against the central handler (no changes needed), F1b `snapshot` result addition is additive over verified consumers, transaction ownership contract (`tx?: pkg.PoolClient`, caller-owned vs `withTransaction`), and gapless-sequence semantics (MAX+1 under row lock, not PG nextval). F1c/F2a remain unauthorized pending approval.
- Phase F Batch 2 (F1c+F2a) implementation: session HTTP routes (`POST /worlds/:id/sessions`, `GET /sessions/:id` with 404-not-403 ownership in `GetReaderSessionUseCase`), F1b additive `snapshot` result (201 exposes only the five public fields), `PostgresSessionRepository.applyTransition` (single-transaction lock/version-check/entity-transition/update/timeline-append, 409 with `report.currentVersion`, caller-owned `tx` contract, MAX+1 sequence under row lock). tsc clean, 191/191 unit tests (9 new); Testcontainers integration tests UNVERIFIED (no Docker).
- F2a deterministic timeline-insert-failure integration test (Proxy-sabotaged caller tx): proves an insert failure rolls back the session update. Test-only addition, no production code changed; UNVERIFIED until Docker/Testcontainers runs it.
- Concurrent-publishing integration test (verification-track item 4): tests/integration/concurrent-publishing.test.ts fires 5 concurrent PublishWorldUseCase.execute calls against the same world and asserts distinct snapshot versions 1..5, verifying the transaction-scoped per-world advisory lock in PostgresCanonRepository.nextVersion serializes version allocation. Suite now 8 files / 31 tests, passing against real PostgreSQL 16.2 (TEST_DATABASE_URL) and stable across consecutive runs against the same database.

### Fixed
- Centralized error handling: Zod errors → 400, typed domain errors → mapped status codes; fixed production startup script for missing `.env`.
- Migration 002 made non-destructive: existing session tokens hashed in place instead of dropping the table.
- Deployment: `fly.toml` memory locked to 256mb; Dockerfile `EXPOSE 8080` corrected.
- `.env.example` now contains only placeholders (removed real dev password).
- Duplicate-email registration race maps the PostgreSQL unique violation to 409 Conflict.
- Code-review remediation: per-route rate limiting, env-driven CORS, register auto-login, login timing side-channel fix, expired-session janitor, `DELETE /worlds/:id`.
- `package-lock.json` committed for `@fastify/rate-limit` and `@fastify/cors`.
- PostgreSQL integration VERIFIED 2026-10-13: 30/30 tests across all 7 integration files passed against real PostgreSQL 16.2 (new TEST_DATABASE_URL env fallback in each file; Testcontainers remains default). Fixed two genuine test bugs exposed by the run: session-persistence seed FK violation, migration.test hardcoded-email conflict. No production code changed. Item 4 (concurrent publishing advisory-lock) still has no integration test.
- Rerun-safety of integration test seeds against a reused database: session-persistence, canon-immutability, and auth-session tests used fixed seed emails/user IDs with ON CONFLICT DO NOTHING, so reruns against the same DB failed (worlds_creator_id_fkey violations; accumulated auth_sessions rows). Seed identities are now unique per run. Test-only changes; no production code affected.

### Security
- scrypt password hashing (N=16384, r=8, p=1, 64-byte key, per-hash salt, timing-safe verify).
- Session tokens stored as SHA-256 hashes; login returns generic 401 with dummy scrypt verify to prevent user enumeration and timing side-channels.
- Rate limiting: 100 req/min global, 10 req/min on login/register; CORS off by default with env-driven origin.
