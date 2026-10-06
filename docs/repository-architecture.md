# Phase 13: Repository Architecture — Corrected Master Specification — Re:NeWrld

Governed by **Project Growth v1.1.0** and [`docs/governance.md`](governance.md).

---

## 1. Introduction & Authority
This document defines the authoritative **Repository Architecture and Modular Monolith Directory Layout** for **Re:NeWrld**. It incorporates all corrections regarding premature framework/provider commitments (removing specific LLM provider names, removing specific frontend client libraries like Axios/Fetch and React Query, and decoupling dependency injection from Fastify plugin specifics while retaining constructor injection via abstractions).

---

## 2. Complete Proposed Repository Directory Tree (Modular Monolith)

```text
ReNeWrld/
├── .env.example
├── .gitignore
├── AGENTS.md
├── CHANGELOG.md
├── Dockerfile                      # Production container build (ADR-010)
├── docker-compose.yml              # Local dev services (PostgreSQL + App)
├── GEMINI.md
├── PROJECT_STATE.md
├── README.md
├── ROADMAP.md
├── TASKS.md
├── package.json
├── tsconfig.json
├── .github/
│   └── workflows/
│       └── ci.yml                  # CI/CD test, lint, and build pipeline (ADR-010)
├── db/
│   ├── migrations/                 # Versioned SQL schema migrations (ADR-002)
│   └── seeds/                      # Initial seed data for test/dev worlds
├── docs/                           # Architecture & design documentation
├── scripts/                        # Database migration & seeding tooling scripts
├── src/
│   ├── server.ts                   # Fastify bootstrap & HTTP entry point
│   ├── app.ts                      # Fastify plugin composition, middleware & error handling
│   ├── config/
│   │   └── env.ts                  # Centralized Zod environment & secret validation (ADR-011)
│   ├── shared/                     # Cross-cutting kernel (Governance rules defined below)
│   │   ├── errors/                 # Standardized API error envelopes & domain errors
│   │   ├── logger/                 # Pino structured logger with request correlation IDs
│   │   ├── middleware/             # Fastify middleware (Auth, Rate Limiting, Idempotency)
│   │   ├── resiliency/             # Exponential backoff retry & circuit breaker utilities
│   │   └── ports/                  # Genuinely cross-cutting future abstractions only (e.g., IntfJobQueue)
│   ├── modules/                    # Modular Monolith Bounded Contexts
│   │   ├── auth/                   # Authentication, Authorization, and User Identity
│   │   │   ├── domain/             # User entity, RBAC roles, auth value objects & repository ports
│   │   │   ├── application/        # Login, registration, session validation use cases & public facade
│   │   │   └── infrastructure/     # PostgreSQL user repository adapter, secure session cookie service
│   │   ├── world/                  # World Authoring, Characters, Stories, Scenes, Publishing & Validation
│   │   │   ├── domain/             # World, Scene, Node, Choice entities & publishing validation rules
│   │   │   ├── application/        # Authoring use cases, publishing graph traversal handler & public facade
│   │   │   └── infrastructure/     # PostgreSQL draft world & Published Canon snapshot repositories
│   │   ├── session/                # Reader Runtime, State, Timeline Experience & Choice Progression
│   │   │   ├── domain/             # Reader session aggregate, variable map, choice evaluation logic
│   │   │   ├── application/        # Choice submission use case, state transition orchestrator & public facade
│   │   │   └── infrastructure/     # PostgreSQL session state repository & append-only timeline repository
│   │   └── intelligence/           # Optional AI/Media Integration & Orchestration (Auxiliary only)
│   │       ├── domain/             # Non-authoritative AI/media integration value objects & IntfAIGateway / IntfMediaGateway port contracts
│   │       ├── application/        # AI assistance coordinator & public facade
│   │       └── infrastructure/     # External AI / Media API integration adapters (implementing intelligence ports)
│   └── web/                        # React Frontend SPA Presentation Layer (ADR-001)
│       ├── src/
│       │   ├── components/         # Reusable UI primitives & layout components
│       │   ├── hooks/              # Provider-neutral API state management hooks
│       │   ├── pages/              # Creator Studio, Reader View, Auth pages
│       │   └── services/           # Provider-neutral API client services communicating with REST endpoints
│       └── package.json
└── tests/
    ├── unit/                       # Vitest unit test suites (pure domain logic & use cases)
    ├── integration/                # Vitest + PostgreSQL Testcontainers integration test suites
    └── fixtures/                   # Test fixtures & mock worlds
```

---

## 3. Core Architectural Boundaries & Hardening Rules

### A. Clean Architecture Dependency Direction & Port Injection
- **Dependency Flow**: `Presentation (Controllers / React) -> Application (Use Cases) -> Domain (Core Business Logic)`.
- **Infrastructure Role**: `Infrastructure` adapters implement inward-facing ports (repositories, `IntfAIGateway`, `IntfMediaGateway`) owned and defined by Domain or Application layers. Infrastructure **never** depends on Presentation.
- **Port Injection**: Use cases and domain services receive repository and gateway instances through implementation-neutral dependency injection patterns (such as constructor injection via abstractions and ports), maintaining complete testability and decoupling from concrete database drivers (`pg`) or specific transport frameworks.

### B. Module-to-Module Isolation & Public Service Facades
- **Strict Isolation**: Modules (`auth`, `world`, `session`, `intelligence`) are strictly decoupled. Direct access to another module's internal domain logic, private repositories, infrastructure adapters, database tables, or private helper files is **prohibited**.
- **Public Service Facades**: Inter-module communication must occur exclusively through designated public application service entry points or facades exposed by each module, preventing internal implementation leakage.

### C. Domain Authority & Intelligence Restrictions
- **Authoritative Domain Logic**: Deterministic condition evaluation, state transitions, narrative resolution, publishing validation, Canon rules, Reader State, and Timeline authority reside **exclusively** within their owning domain/application modules (`world/` and `session/`).
- **Intelligence Domain Boundary (`src/modules/intelligence/domain/`)**: Contains **only** non-authoritative AI/media integration value objects, prompt templates, and gateway port contracts (`IntfAIGateway`, `IntfMediaGateway`). It has **zero** authoritative Re:NeWrld game-domain logic, Canon rules, Reader State logic, narrative authority, or state mutation rights.
- **Gateway Ownership**: `IntfAIGateway` and `IntfMediaGateway` are authoritatively located in `src/modules/intelligence/domain/ports/`, while their concrete integration adapters reside in `src/modules/intelligence/infrastructure/` (utilizing provider-neutral external client wrappers).

### D. `shared/` & `shared/ports/` Governance (Anti-Dumping Ground Rules)
- **Allowed in `shared/`**: Pino logger, standardized error envelopes, retry/resiliency helpers, and cross-cutting Fastify middleware (Auth, Rate Limiting, Idempotency).
- **Allowed in `shared/ports/`**: Genuinely cross-cutting future approved abstractions only, such as `IntfJobQueue` (ADR-005).
- **Prohibited in `shared/` / `shared/ports/`**: Domain-specific repositories, AI/media contracts, module business interfaces, application-specific abstractions, database entities, or direct SQL queries. `shared/` must never become a dumping ground.

### E. Authentication Strategy (ADR-004)
- **Authentication**: Aligned strictly with ADR-004, utilizing **Session-Based Authentication using Secure, HttpOnly, SameSite=Strict cookies backed by server-side session validation, coupled with Fastify RBAC middleware enforcing Creator vs. Reader permissions**.

### F. Transactional Invariants & Publishing Validation
- **Session Mutation Atomicity**: Reader State mutation and Timeline append operations occur atomically within a single ACID transaction (`REPEATABLE READ`), ensuring data consistency.
- **Publishing Validation**: Publishing validation graph traversal follows automated detailed design specifications without enforcing a universal database transaction isolation requirement across all authoring check operations unless established by workflow design.

---

## 4. Recheck & Unresolved Findings
- **Recheck Performed**: Reviewed the complete document to eliminate premature library, SDK, provider, or framework commitments.
- **Findings**: All specific LLM vendor names, frontend HTTP library names, and framework-specific injection prescriptions have been successfully removed and replaced with robust, provider-neutral abstractions and implementation-neutral dependency injection wording.
- **Status**: **PASS (Corrected and Rechecked)**.
