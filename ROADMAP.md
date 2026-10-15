# ROADMAP — Re:NeWrld

Governed by **Project Growth v1.1.0** and [`docs/governance.md`](governance.md).

---

## 1. Executive Summary & Phasing Strategy
This roadmap defines the authoritative implementation plan for **Re:NeWrld**. It sequences work into coherent phases forming a dependency graph (critical path), transitioning from completed specifications (Phases 0–13) through MVP realization to deferred post-MVP extensions. Each phase defines explicit dependencies, concurrent testing integration, quality gates, and measurable completion criteria.

---

## 2. Implementation Phases & Sequencing (Dependency Graph)

### Phase A: Repository Foundation & Bootstrap
- **Objective**: Initialize the modular monolith repository structure, TypeScript compilation settings, centralized Zod environment validation (`src/config/env.ts`), structured Pino logging, and standard error handling.
- **Dependencies**: None (Root foundation).
- **Critical Path Placement**: Entry point for all backend and shared work.
- **Gate**: Zero unvalidated environment access; successful build (`tsc`).
- **Deliverables**: Directory structure (`src/server.ts`, `src/app.ts`, `src/config/`, `src/shared/`), ESLint/Prettier, and base configuration.
- **Completion Criteria**: Clean build, centralized configuration validation passing, structured logging operational.

### Phase B: Database & Persistence Layer
- **Objective**: Establish PostgreSQL database connectivity, versioned SQL schema migrations (`db/migrations/`), and Testcontainers integration test fixtures (ADR-002, ADR-009).
- **Dependencies**: Phase A.
- **Continuous Testing**: Unit tests for persistence ports and repository stubs written concurrently.
- **Gate**: Successful migration runner execution; ephemeral PostgreSQL Testcontainers connection verified.
- **Deliverables**: Migration scripts, database connection pool, repository base ports, and integration test harness.
- **Completion Criteria**: Migrations apply cleanly, integration test harness successfully communicates with database container.

### Phase C: Authentication & Authorization (RBAC)
- **Objective**: Implement user credentials, session-based authentication using Secure, HttpOnly, SameSite=Strict cookies backed by server-side session validation, Fastify RBAC middleware enforcing Creator vs. Reader permissions (ADR-004), and self-serve password reset via time-limited single-use email tokens (FR-13, ADR-012).
- **Dependencies**: Phase B.
- **Continuous Testing**: RBAC and session middleware unit tests developed concurrently.
- **Gate**: RBAC middleware unit tests passing; session creation and revocation verified.
- **Deliverables**: `modules/auth/` domain entities, use cases, repository adapters, RBAC security middleware, password-reset use cases + token store + email port.
- **Completion Criteria**: Unauthenticated requests rejected; Creator and Reader roles correctly authorized/restricted; users can recover accounts via reset flow without operator intervention.

### Phase D: Creator & World Authoring Subsystem
- **Objective**: Implement authoring domain models and use cases for worlds, characters, story arcs, scenes, and draft nodes (`modules/world/`).
- **Dependencies**: Phase B, Phase C (Creator RBAC).
- **Continuous Testing**: Domain invariant and authoring use case unit tests written concurrently.
- **Gate**: Creator authorization enforced on authoring routes; domain invariant tests passing.
- **Deliverables**: `modules/world/domain/` entities and `modules/world/application/` authoring use cases.
- **Completion Criteria**: Creators can create, update, and manage draft world authoring graphs.

### Phase E: Story, Scene & Publishing Validation
- **Objective**: Implement graph traversal validation, reachability checks, and immutable Published Canon snapshot generation. **Status (2026-10-13)**: implemented and code-reviewed — E0 (migration 004), E1a/E1b (validators), E2a (publish use case + snapshot repository), E2b (`POST /worlds/:id/publish` route), E2c (immutability trigger migration 005); tsc clean, 166/166 unit tests. PostgreSQL integration (concurrent publishing, JSONB round-trip, trigger behavior, migration 005 execution) UNVERIFIED until Testcontainers/CI runs it. Design: ADR-013 (Proposed).
- **Dependencies**: Phase D.
- **Continuous Testing**: Publishing graph algorithms tested concurrently via Vitest unit tests (pure validators, no DB).
- **Gate**: Publishing validation test suite passing for valid and invalid graph topologies; immutability trigger verified.
- **Deliverables**: Schema markers migration 004 (`worlds.start_scene_id` + same-world composite FK; `scenes.is_ending` column already exists — entity mapping only), graph validators (E1a/E1b), publish use case + snapshot repository (E2a), `POST /worlds/:id/publish` route (E2b), canon immutability trigger migration 005 (E2c).
- **Completion Criteria**: Draft worlds passing validation successfully transition to versioned Published Canon snapshots; snapshots immutable at application and database layers.

### Phase F: Reader Runtime, State & Timeline Experience
- **Objective**: Implement active reader session initialization bound to specific published canon versions, variable state maps, and append-only timeline logs (`modules/session/`). **Prerequisite**: Phase E gap-closure (E0–E2c) implemented & code-reviewed 2026-10-13 — PostgreSQL integration UNVERIFIED (tracked separately); F-tasks begin only after product-owner approval of the Phase F design per AGENTS.md prerequisite rules. Idempotency contract specified (ADR-013 D3); enforcement lands with Phase G choice submission.
- **Dependencies**: Phase C (Reader Auth), Phase E (Published Canon).
- **Continuous Testing**: Session state and timeline append unit tests executed concurrently; transaction tests via Testcontainers (UNVERIFIED until Docker/CI runs them).
- **Gate**: ACID transaction tests ensuring atomic Reader State and Timeline recording; session ownership isolation verified.
- **Deliverables**: Session domain entity + port (F1a), init use case (F1b), session routes (F1c), atomic Postgres persistence (F2a).
- **Completion Criteria**: Readers can initialize sessions pinned to immutable snapshots, and persist state/timeline history atomically; multiple independent playthroughs per reader per world.

### Phase G: Deterministic Narrative Execution
- **Objective**: Implement condition evaluation engines, numeric/boolean state mutations, choice resolution, and next-node rendering logic within the session domain.
- **Dependencies**: Phase F.
- **Continuous Testing**: Pure function condition evaluator tests written and executed continuously.
- **Gate**: 100% unit test coverage for pure condition evaluation and state transition functions.
- **Deliverables**: `modules/session/domain/services/condition-evaluator.ts` and `state-transition.service.ts`.
- **Completion Criteria**: Narrative progression executes deterministically based on player choices and variable maps.
- **Status 2026-10-14**: ACCEPTED (commit c4b85ae; merged PR #2 b9b215a). Implemented per ADR-015 (Accepted). G1 (grammar, evaluator, applier, publish validation) + G2 (idempotency, SubmitChoiceUseCase, POST /sessions/:id/choices). Note: grammar schemas live in `modules/world/domain/services/` per strict module isolation (session→world established direction); evaluator/applier in session. 100% G1 coverage. Verified 2026-10-14: 302/302 unit tests pass (33 files), tsc clean (backend + frontend); 46 integration tests exist but UNVERIFIED in this environment (no Docker); no retained evidence of prior PG 16.2 run in repo.

### Phase H: API & Frontend Integration
- **Objective**: Wire Fastify REST controllers with Zod request/response validation contracts (ADR-003) and build the React SPA frontend communicating via provider-neutral API client services (ADR-001).
- **Dependencies**: Phases C through G (Critical path convergence).
- **Continuous Testing**: Component unit tests and API integration tests executed concurrently.
- **Gate**: End-to-end integration tests passing via Testcontainers and REST contracts.
- **Deliverables**: Fastify route controllers, Zod validation schemas, and React SPA components (`src/web/`).
- **Completion Criteria**: Fully functional frontend interface enabling creator authoring/publishing and reader narrative progression.

### Phase I: AI & Media Gateway Integration (Boundaries & Optional Adapters)
- **Objective**: Implement `IntfAIGateway` and `IntfMediaGateway` port contracts and deterministic fallback handling (`modules/intelligence/`) adhering to strict non-authoritative boundaries (ADR-006). *Note: Specific external AI/media provider SDK integration is optional/deferred for MVP unless explicitly required by downstream scope.*
- **Dependencies**: Phase H.
- **Continuous Testing**: Gateway mock adapter tests executed concurrently.
- **Gate**: Security audit verifying AI/media adapters cannot mutate Published Canon or Reader State directly.
- **Deliverables**: `IntfAIGateway` and `IntfMediaGateway` port interfaces, mock/fallback adapters, and auxiliary UI hooks.
- **Completion Criteria**: Architecture enforces gateway boundary and deterministic fallback; gateway port contracts are fully testable.

### Phase J: Final Quality, Integration & CI/CD Pipeline Verification
- **Objective**: Consolidate automated Vitest unit tests, PostgreSQL Testcontainers integration test pipelines, and establish GitHub Actions CI workflow (ADR-009, ADR-010). *Note: Testing occurs continuously throughout Phases B–I; Phase J provides system-wide verification and headless CI execution.*
- **Dependencies**: Phases A through I.
- **Gate**: CI pipeline passing build, lint, unit tests, and integration tests on every pull request.
- **Deliverables**: `.github/workflows/ci.yml`, aggregated test suites, and coverage reporting.
- **Completion Criteria**: Automated test suites executing successfully in headless CI environment.

### Phase K: Deployment, Containerization & Operations
- **Objective**: Package application into production container (`Dockerfile`) and provide local orchestration (`docker-compose.yml`) adhering to operational runbooks (ADR-010, ADR-011).
- **Dependencies**: Phase J.
- **Gate**: Container build verification and local health check pass.
- **Deliverables**: `Dockerfile`, `docker-compose.yml`, environment configuration templates, and operational runbooks.
- **Completion Criteria**: Application successfully runs and persists state in containerized production-like environment.

---

## 3. Post-MVP Extensions (Deferred & Extensible)
- **Phase L: Asynchronous Background Job Queues (`IntfJobQueue`)**: Pluggable background worker integration (Redis + BullMQ per ADR-005) for batch simulations and analytics.
- **Phase M: Advanced Simulation & Multiverse**: Future agent autonomy, timeline branching, reputation models, and Overseer overrides (reserved via interfaces without premature implementation).
