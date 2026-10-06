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
- **Objective**: Implement user credentials, session-based authentication using Secure, HttpOnly, SameSite=Strict cookies backed by server-side session validation, and Fastify RBAC middleware enforcing Creator vs. Reader permissions (ADR-004).
- **Dependencies**: Phase B.
- **Continuous Testing**: RBAC and session middleware unit tests developed concurrently.
- **Gate**: RBAC middleware unit tests passing; session creation and revocation verified.
- **Deliverables**: `modules/auth/` domain entities, use cases, repository adapters, and RBAC security middleware.
- **Completion Criteria**: Unauthenticated requests rejected; Creator and Reader roles correctly authorized/restricted.

### Phase D: Creator & World Authoring Subsystem
- **Objective**: Implement authoring domain models and use cases for worlds, characters, story arcs, scenes, and draft nodes (`modules/world/`).
- **Dependencies**: Phase B, Phase C (Creator RBAC).
- **Continuous Testing**: Domain invariant and authoring use case unit tests written concurrently.
- **Gate**: Creator authorization enforced on authoring routes; domain invariant tests passing.
- **Deliverables**: `modules/world/domain/` entities and `modules/world/application/` authoring use cases.
- **Completion Criteria**: Creators can create, update, and manage draft world authoring graphs.

### Phase E: Story, Scene & Publishing Validation
- **Objective**: Implement graph traversal validation, reachability checks, and immutable Published Canon snapshot generation (`modules/world/publishing/`).
- **Dependencies**: Phase D.
- **Continuous Testing**: Publishing graph algorithms tested concurrently via Vitest unit tests.
- **Gate**: Publishing validation test suite passing for valid and invalid graph topologies.
- **Deliverables**: Publishing validation use case, graph reachability algorithms, and immutable snapshot repository.
- **Completion Criteria**: Draft worlds passing validation successfully transition to versioned Published Canon snapshots.

### Phase F: Reader Runtime, State & Timeline Experience
- **Objective**: Implement active reader session initialization bound to specific published canon versions, variable state maps, and append-only timeline logs (`modules/session/`).
- **Dependencies**: Phase C (Reader Auth), Phase E (Published Canon).
- **Continuous Testing**: Session state and timeline append unit tests executed concurrently.
- **Gate**: ACID transaction tests ensuring atomic Reader State and Timeline recording (`REPEATABLE READ`).
- **Deliverables**: `modules/session/domain/` aggregates and `modules/session/infrastructure/` persistence adapters.
- **Completion Criteria**: Readers can initialize sessions, submit choices, and persist state/timeline history atomically.

### Phase G: Deterministic Narrative Execution
- **Objective**: Implement condition evaluation engines, numeric/boolean state mutations, choice resolution, and next-node rendering logic within the session domain.
- **Dependencies**: Phase F.
- **Continuous Testing**: Pure function condition evaluator tests written and executed continuously.
- **Gate**: 100% unit test coverage for pure condition evaluation and state transition functions.
- **Deliverables**: `modules/session/domain/services/condition-evaluator.ts` and `state-transition.service.ts`.
- **Completion Criteria**: Narrative progression executes deterministically based on player choices and variable maps.

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
