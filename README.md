# Re:NeWrld

Governed by **Project Growth v1.1.0**.

---

## 1. Overview & Problem Statement
**Re:NeWrld** is a high-integrity, deterministic modular monolith backend and core game engine designed to unify authorial world-building control with personalized reader agency across arbitrary genres (sci-fi, fantasy, historical, thriller, mystery, romance, cyber-punk, horror, literary, or cross-genre hybrids).

Traditional interactive fiction and narrative platforms often suffer from fragile state logic, tight coupling between static story content and runtime player progress, and an over-reliance on non-deterministic generative models that corrupt narrative consistency. Re:NeWrld solves this by establishing a strict architectural separation between creator-authored authoritative baseline truth (**Canon**) and individual reader runtime journeys (**Experience**), powered by a fully deterministic state evaluation engine.

---

## 2. Core Product Concept
Re:NeWrld empowers creators to author rich, branching narrative worlds complete with metadata, flexible character roles (protagonists, antagonists, companions, rivals, villains, factions), chapters, scenes, structured discrete choices, conditions, and terminal endings. Readers step into preset protagonist roles, exploring clean, distraction-free prose, making choices that mutate persistent state deterministically, and reaching governed conclusion nodes.

---

## 3. Canon vs. Experience vs. Timeline
- **Canon Data**: Creator-authored world assets, rules, chapters, and scenes that serve as authoritative baseline truth. Published Canon is immutable within a specific published version and cannot be mutated by runtime reader choices, automated systems, or AI.
- **Experience Data**: Reader-specific runtime variables (inventory, relationship/trust scores, custom flags/counters) and session state. Isolated per reader account with atomic persistence and rollback protection.
- **Timeline Experience**: The unique, procedural sequence of scenes, choices, and state transitions experienced by a reader, orchestrating scene presentation and condition evaluation against Story Structure and Reader State.

---

## 4. MVP Scope & Non-Goals
- **MVP Scope**:
  - Modular monolith backend (Fastify + TypeScript) with PostgreSQL persistence.
  - Creator authoring asset support and publishing validation pipeline.
  - Deterministic state machine and condition evaluator.
  - Session-based authentication & secure HttpOnly cookies (Creator vs. Reader RBAC).
  - Centralized Zod environment validation.
  - Optional AI presentation gateway (strict input/output contracts, zero state/canon authority).
- **Non-Goals (Post-MVP / Future)**:
  - Real-time collaborative multi-author workspaces.
  - Custom reader-created protagonist generation (preset MVP roles only).
  - Free-text input choice evaluation (discrete choice buttons only for MVP).
  - Advanced Tier 1–3 autonomous simulation engines (deferred to post-MVP).

---

## 5. Major Capabilities
- **Deterministic Narrative Engine**: Zero AI dependency for core branching, state transitions, condition evaluation, and inventory/relationship tracking.
- **Publishing Validation Pipeline**: Automated checks verifying target scene existence, detecting orphaned/unreachable scenes, ensuring reachable terminal endings, and rejecting invalid publications.
- **Role-Based Access Control (RBAC)**: Strict permission boundaries separating Creators from Readers.
- **Secure Configuration & Observability**: Centralized Zod environment validation and Pino structured logging with request correlation IDs (`x-request-id`).

---

## 6. Architecture & Modular Monolith Structure
Re:NeWrld follows Clean Architecture principles organized around domain boundaries:
- `src/modules/auth/` — User entity, RBAC roles, authentication domain & adapters.
- `src/modules/world/` — Creator Canon assets, world metadata, and rules.
- `src/modules/session/` — Reader session state, inventory, and experience tracking.
- `src/modules/intelligence/` — Non-authoritative AI/media integration ports (`IntfAIGateway`, `IntfMediaGateway`) and adapters.
- `src/shared/` — Cross-cutting foundational abstractions and infrastructure clients.
- `src/config/` — Centralized Zod environment validation schema (`src/config/env.ts`).

---

## 7. Approved Technology Stack
- **Runtime / Language**: Node.js `>= 20.0.0`, TypeScript (`tsc`).
- **Web / API Framework**: Fastify (`^4.28.1`).
- **Validation**: Zod (`^3.23.8`).
- **Database / Persistence**: PostgreSQL (relational tables + JSONB payload support, migration runner).
- **Testing**: Vitest (`^2.0.3`) & PostgreSQL Testcontainers integration testing.
- **Observability**: Pino structured logging with correlation IDs.

---

## 8. Deterministic Narrative Engine & AI Boundary
- **Core Principle**: *"Mystery to the reader does not mean uncertainty in authoritative backend rules."*
- **AI Boundary**: AI functions strictly as an optional presentation layer (prose styling, tone adaptation, dialogue flavoring). It never owns story logic, state authority, or canon validity. Untrusted-input isolation and Zod schema contracts govern all AI touchpoints.

---

## 9. Security & Governance Principles
- **Credential Protection**: Zero hardcoded secrets; rigorous Zod environment variable validation at startup (fail-fast security).
- **Data Isolation**: Multi-tenant isolation ensuring creator IP and reader session data remain strictly segregated.
- **AI Guardrails**: Bounded AI authority, prompt injection defense, and token usage governance.
- **Governance Framework**: Governed by Project Growth v1.1.0 specifications and execution rules.

---

## 10. Current Implementation Status
- **Phase 15 Implementation Status**: **Active / Sprint 1 Execution**
- **Completed Tasks**:
  - **Task A1 (Repository Foundation & Bootstrap)**: Modular monolith directory layout established, Fastify bootstrap (`src/server.ts`, `src/app.ts`) configured with `/health` endpoint, and Vitest unit test verified (`tests/unit/app.test.ts`).
  - **Task A2 (Centralized Zod Environment Validation)**: Installed `zod`, implemented strict startup validation schema (`src/config/env.ts`) covering `APP_ENV`, `LOG_LEVEL`, `PORT`, and `HOST`, updated server integration, and added comprehensive unit tests (`tests/unit/env.test.ts`).
- **Next Task**: Task A3 (Configure Pino Structured Logger with Correlation ID Tracking).

---

## 11. Repository Structure
```text
ReNeWrld/
├── .env.example
├── AGENTS.md
├── CHANGELOG.md
├── GEMINI.md
├── PROJECT_STATE.md
├── README.md
├── ROADMAP.md
├── TASKS.md
├── tsconfig.json
├── package.json
├── package-lock.json
├── docs/                   # Authoritative specification and design documents
├── governance/             # AI agent governance rules
├── src/
│   ├── app.ts              # Fastify application builder & health route
│   ├── server.ts           # Server entry point consuming validated env config
│   ├── config/             # Zod environment validation (env.ts)
│   ├── modules/            # Domain modules (auth, world, session, intelligence)
│   └── shared/             # Shared cross-cutting components & ports
├── tests/
│   ├── fixtures/
│   ├── integration/        # PostgreSQL Testcontainers tests
│   └── unit/               # Vitest unit tests (app.test.ts, env.test.ts)
└── workflows/              # Authoritative engineering lifecycle workflows
```

---

## 12. Development Prerequisites & Local Setup
1. **Prerequisites**: Node.js `>= 20.0.0`, npm `>= 10.x`.
2. **Setup**:
   ```bash
   git clone https://github.com/abelsvj-afk/Re-NeWrld.git
   cd ReNeWrld
   npm install
   cp .env.example .env
   # Configure local environment variables in .env if needed
   ```

---

## 13. Available NPM Commands
- `npm run build` — Compile TypeScript source files (`tsc`).
- `npm start` — Run compiled production server (`node dist/server.js`).
- `npm run dev` — Start development file watcher (`tsx watch src/server.ts`).
- `npm test` — Run unit test suite once (`vitest run`).
- `npm test:watch` — Run unit tests in interactive watch mode (`vitest`).

---

## 14. Testing & Build Workflow
- **Unit Testing**: Run `npm test` to execute Vitest test suites.
- **Integration Testing**: PostgreSQL integration tests run against isolated Testcontainers instances.
- **Type Checking & Build**: Run `npm run build` to verify strict TypeScript compilation (`tsc`).

---

## 15. Roadmap & Deferred Features
- **MVP Roadmap Phases (A – K)**:
  - **Phase A**: Repository Foundation & Bootstrap (In Progress / Tasks A1–A3).
  - **Phase B**: Database & Persistence Layer (PostgreSQL pool & migrations).
  - **Phase C**: Authentication & Authorization (RBAC & secure cookies).
  - **Phase D**: Creator & World Authoring Subsystem.
  - **Phase E**: Story, Scene & Publishing Validation.
  - **Phase F**: Reader Runtime, State & Timeline Experience.
  - **Phase G**: Deterministic Narrative Execution.
  - **Phase H**: API & Frontend Integration (Fastify REST + React SPA).
  - **Phase I**: AI & Media Gateway Integration (Boundaries & optional adapters).
  - **Phase J**: Final Quality, Integration & CI/CD Pipeline Verification.
  - **Phase K**: Deployment, Containerization & Operations (`Dockerfile`, `docker-compose.yml`).
- **Post-MVP Extensions (Deferred Phases L – M / Future)**:
  - **Phase L**: Asynchronous Background Job Queues (`IntfJobQueue` via Redis + BullMQ).
  - **Phase M**: Advanced Simulation, Multiverse, and Agent Autonomy (Future Tiers 1–3).

---

## 16. Contribution & Development Rules
- Strict compliance with **Project Growth v1.1.0** governance.
- Spec-first engineering: No implementation code without approved requirements, architecture, and task definition in `TASKS.md`.
- Mandatory automated tests for every code change.
- Prohibition of silent changes or unapproved technology additions.

---

## 17. Authoritative Documentation References
For deep architectural and design details, consult the documents in [`docs/`](docs/):
- [`docs/idea.md`](docs/idea.md) — Problem discovery and value proposition.
- [`docs/vision.md`](docs/vision.md) — Product scope, boundaries, and non-goals.
- [`docs/requirements.md`](docs/requirements.md) — Functional and non-functional requirements.
- [`docs/architecture.md`](docs/architecture.md) — Component boundaries and data flow.
- [`docs/detailed-design.md`](docs/detailed-design.md) — Contracts, schemas, and interface design.
- [`docs/repository-architecture.md`](docs/repository-architecture.md) — Modular monolith structure and anti-dumping rules.
- [`docs/decisions/`](docs/decisions/) — Architecture Decision Records (ADRs 001–011).
