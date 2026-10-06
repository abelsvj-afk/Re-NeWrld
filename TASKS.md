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
- **Task B1: Establish PostgreSQL Connection Pool & Base Repository Port Abstractions**
  - **Phase**: Phase B (Persistence)
  - **Prerequisites**: Task A2
  - **Ownership**: `src/shared/`, database config
  - **File Scope**: Database connection pool client, repository base port definitions complying with shared anti-dumping governance
  - **Objective**: Configure secure PostgreSQL connection pooling and define generic repository port abstractions without violating module ownership boundaries.
  - **Traceability**: `docs/architecture.md`, ADR-002
  - **Acceptance Criteria**: Connection pool establishes successfully; base repository port interfaces defined.
  - **Required Tests**: Integration test connecting to PostgreSQL Testcontainers instance.
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
- **Task E1: Implement Publishing Graph Traversal & Reachability Validation**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task D2
  - **Ownership**: `src/modules/world/application/`
  - **File Scope**: Publishing use cases, graph validator service
  - **Objective**: Implement graph reachability algorithms, orphaned node detection, and structural completeness checks before publication.
  - **Traceability**: `docs/automation-design.md`, `docs/system-completeness.md`
  - **Acceptance Criteria**: Invalid graphs fail publishing validation with descriptive error logs; valid graphs pass.
  - **Required Tests**: Unit tests with diverse valid and invalid world graph topologies.
  - **Definition of Done**: Publishing graph validation service fully tested and integrated.

- **Task E2: Implement Immutable Published Canon Snapshot Generation**
  - **Phase**: Phase E (Publishing)
  - **Prerequisites**: Task E1
  - **Ownership**: `src/modules/world/infrastructure/`
  - **File Scope**: Published canon repository, versioning service
  - **Objective**: Store validated draft worlds as immutable, versioned Published Canon snapshots (`published_canon_snapshots`).
  - **Traceability**: `docs/detailed-design.md`, `docs/architecture.md`
  - **Acceptance Criteria**: Publishing creates a distinct, read-only canon version snapshot.
  - **Required Tests**: Integration tests verifying immutability and version retrieval.
  - **Definition of Done**: Published Canon snapshots securely stored and immutable.

---

### Roadmap Phase F: Reader Runtime, State & Timeline Experience
- **Task F1: Implement Reader Session Initialization & State Loading**
  - **Phase**: Phase F (Reader Runtime)
  - **Prerequisites**: Task C3, Task E2
  - **Ownership**: `src/modules/session/application/` & `infrastructure/`
  - **File Scope**: Session initialization use case, PostgreSQL session repository
  - **Objective**: Initialize active reader sessions bound to specific published canon versions (`canon_version_id`).
  - **Traceability**: `docs/runtime-design.md`, `docs/user-stories.md`
  - **Acceptance Criteria**: Sessions correctly load canon snapshot data and initialize reader state variables.
  - **Required Tests**: Integration tests verifying session creation and state loading.
  - **Definition of Done**: Reader session lifecycle initialization operational.

- **Task F2: Implement Atomic Reader State Mutation & Timeline Append Repository**
  - **Phase**: Phase F (Reader Runtime)
  - **Prerequisites**: Task F1
  - **Ownership**: `src/modules/session/infrastructure/`
  - **File Scope**: PostgreSQL transaction manager, session state repository, timeline repository
  - **Objective**: Ensure Reader State updates and Timeline log appends execute atomically within a single ACID transaction (`REPEATABLE READ`).
  - **Traceability**: `docs/runtime-design.md`, ADR-002
  - **Acceptance Criteria**: Failure in either state mutation or timeline append triggers an instant database rollback.
  - **Required Tests**: Integration tests simulating transaction failures and verifying rollback integrity.
  - **Definition of Done**: ACID persistence guarantees fully verified.

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
