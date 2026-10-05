# Phase 9: Service Specifications (Pass 1, 2 & 3 Audit) — Re:NeWrld

Governed by **Project Growth v1.1.0**.

---

## 1. Introduction & Authority
This document defines the authoritative service boundaries, responsibilities, data ownership models, dependency rules, transaction ownership, and security constraints for the core services of **Re:NeWrld**. All implementation code developed in subsequent phases **must** strictly adhere to these service specifications.

---

## 2. Core Service Specifications (8 Logical Services)

### 2.1 API / Application Layer (Fastify Gateway)
- **Purpose**: Serves as the secure ingress point for all client requests (Creator Dashboard and Reader Client), handling request routing, session authentication, RBAC authorization, and Zod runtime schema validation.
- **Owned Data**: Ephemeral request context, correlation IDs, rate-limiting counters.
- **Allowed Dependencies**: Auth Service, Authoring Service, World/Character Service, Story/Scene Service, Publishing Service, Reader Runtime Service, State/Timeline Service.
- **Forbidden Dependencies**: Direct database access / repository queries bypassing domain services.
- **Major Operations**: Route incoming HTTP requests, validate request bodies/params against Zod schemas, dispatch requests to underlying domain services, format standardized success/error response envelopes.
- **Security Boundary**: Enforces HTTPS/TLS termination, security headers (CSP, HSTS, X-Frame-Options), CORS allowlist, Fastify RBAC middleware, and input sanitization against prompt injection.
- **Transaction Ownership**: Non-transactional ingress layer; delegates transaction management to domain services.
- **Canon vs. Experience Relationship**: Handles API requests for both Canon assets (Creator) and Experience runtime sessions (Reader).

### 2.2 Authentication / Authorization Service (Auth & RBAC)
- **Purpose**: Manages user account credentials, secure session cookies (HttpOnly, SameSite=Strict), and Role-Based Access Control enforcing strict separation between Creators and Readers.
- **Owned Data**: User credentials (argon2id hashed passwords), active session records, user role definitions (`creator`, `reader`).
- **Allowed Dependencies**: Database persistence layer (Auth Repository).
- **Forbidden Dependencies**: Narrative Engine, Publishing Validator, AI Gateway.
- **Major Operations**: User registration, login verification, session cookie issuance, session validation lookup, logout/revocation, RBAC role inspection.
- **Security Boundary**: Core security boundary protecting account takeover and privilege escalation.
- **Transaction Ownership**: Manages its own ACID transactions for user creation and session updates.
- **Canon vs. Experience Relationship**: Orthogonal core service required for both Creators and Readers to secure access to Canon and Experience data.

### 2.3 Creator / Authoring Service
- **Purpose**: Handles creator project management, world metadata initialization, and project-level settings.
- **Owned Data**: World metadata records (`worlds` table: title, genre, summary, setting rules, tone, status).
- **Allowed Dependencies**: Auth Service (for creator permission verification), Database persistence layer.
- **Forbidden Dependencies**: Reader Runtime Service, Experience State tables.
- **Major Operations**: Create world, update world metadata, list creator worlds, retrieve draft world status.
- **Security Boundary**: Enforces creator ownership scoping (creators can only modify worlds they own).
- **Transaction Ownership**: Owns transactional boundaries for world metadata mutations.
- **Canon vs. Experience Relationship**: Purely **Canon Data** authoring.

### 2.4 World / Character Service
- **Purpose**: Manages character profiles and flexible narrative roles (protagonists, antagonists, companions, rivals, villains, factions, custom roles) across arbitrary genres.
- **Owned Data**: Character and role records (`characters` table: name, role type, description, attributes JSONB).
- **Allowed Dependencies**: Creator Authoring Service, Database persistence layer.
- **Forbidden Dependencies**: Reader runtime session execution.
- **Major Operations**: Create character/role, update character attributes, list world characters, delete draft character.
- **Security Boundary**: Scoped to creator world ownership and published version immutability rules.
- **Transaction Ownership**: Owns transactional boundaries for character and role mutations.
- **Canon vs. Experience Relationship**: Purely **Canon Data** authoring.

### 2.5 Story / Scene Service
- **Purpose**: Manages chapters, narrative prose blocks, structured discrete choices, condition criteria, and state-mutation definitions.
- **Owned Data**: Chapters, scenes, choices, condition rules, and mutation records (`chapters`, `scenes`, `choices` tables).
- **Allowed Dependencies**: Creator Authoring Service, World/Character Service, Database persistence layer.
- **Forbidden Dependencies**: Direct reader runtime state modification.
- **Major Operations**: Create chapter, author scene prose, attach discrete choices, define condition rules and mutation effects, update draft scene graphs.
- **Security Boundary**: Creator ownership enforcement; relational referential integrity on draft structures.
- **Transaction Ownership**: Owns transactional boundaries for story structure authoring.
- **Canon vs. Experience Relationship**: Purely **Canon Data** authoring.

### 2.6 Publishing / Validation Service
- **Purpose**: Executes automated graph traversal validation checks on draft worlds before promoting them to Published status with a locked version snapshot.
- **Owned Data**: Published version snapshots and validation report audit logs.
- **Allowed Dependencies**: Creator Authoring Service, World/Character Service, Story/Scene Service, Database persistence layer.
- **Forbidden Dependencies**: Live active reader session states.
- **Major Operations**: Trigger publishing validation check, traverse scene graph, verify target reference existences, detect orphaned scenes, verify terminal ending node reachability, validate condition/mutation references, lock published version snapshot, reject invalid publications.
- **Security Boundary**: Enforces structural publication gating; protects published catalog integrity.
- **Transaction Ownership**: Owns transactional boundaries for publishing status updates and version snapshot locking.
- **Canon vs. Experience Relationship**: Bridges drafted Canon Data to published, version-immutable Canon Data.

### 2.7 Reader Runtime Service
- **Purpose**: Manages active reader reading sessions, catalog browsing of published worlds, and session initialization bound to published version snapshots.
- **Owned Data**: Reader session metadata (`sessions` table: reader ID, world ID, active published version ID, current scene ID).
- **Allowed Dependencies**: Auth Service, Publishing Service, Deterministic Narrative Engine, State/Timeline Service.
- **Forbidden Dependencies**: Creator Authoring mutation endpoints.
- **Major Operations**: Browse published catalog, initialize reading session, load current scene payload, inspect character sheet.
- **Security Boundary**: Enforces reader session isolation (`reader_id` scoping).
- **Transaction Ownership**: Owns transactional boundaries for session initialization and scene retrieval.
- **Canon vs. Experience Relationship**: Consumes immutable published **Canon Data**; initializes and manages **Experience Data**.

### 2.8 State / Timeline Service (Deterministic Narrative Engine)
- **Purpose**: Evaluates discrete choice condition rules deterministically against reader state, executes atomic state mutations (inventory, trust scores, flags), records timeline progression history, and provides rollback protection on persistence failure.
- **Owned Data**: Reader runtime experience state (`reader_state`, `inventory`, `relationships`, `flags`, `timeline_history` tables).
- **Allowed Dependencies**: Reader Runtime Service, Database persistence layer.
- **Forbidden Dependencies**: Creator authoring mutation endpoints, AI presentation logic.
- **Major Operations**: Evaluate condition rules, apply state mutations atomically, record timeline history, persist session state, execute atomic rollback on persistence failure.
- **Security Boundary**: Enforces strict state isolation and tamper-evident state mutation rules.
- **Transaction Ownership**: Own ACID transaction boundaries for state transitions, ensuring atomic mutation and timeline recording with rollback protection.
- **Canon vs. Experience Relationship**: Purely **Experience Data** management.

---

## 3. Inter-Service Communication, Data Flows & Resilience (Pass 2 of 3)

### 3.1 Synchronous Request & Data Flows
- **Logical Modular Boundaries**: The 8 services operate as internal domain modules within the Fastify application monolith communicating via synchronous typed function calls, ensuring zero network overhead while maintaining strict interface segregation and dependency direction.
- **Determinism vs. Persistence Separation**: The State/Timeline Service (Deterministic Narrative Engine) performs pure rule evaluation in-memory; persistence operations are strictly delegated to repository boundaries inside ACID database transactions.
- **AI / Media Gateway Isolation**: Optional AI presentation gateways (`IntfAIGateway`) and media storage gateways (`IntfMediaGateway`) are isolated via plugin adapters. They *cannot* bypass domain services or mutate Canon Data. If an AI gateway fails, the system falls back to pure authored prose without disrupting state execution.

### 3.2 Error Propagation, Validation & Failure Handling
- **Zod Validation Semantics**: Every inter-service method call and API boundary enforces Zod schema validation. Malformed data throws structured validation errors caught by global error handlers and formatted into standardized error envelopes.
- **Transaction Rollback & Resilience**: State mutations executed by the State/Timeline Service wrap updates in database transactions. If database persistence fails, the transaction rolls back completely, preventing partial state corruption.
- **Idempotency**: Choice execution requests accept client-supplied idempotency keys to safely handle network retries without double-mutating reader state.

---

## 4. Phase 9 Service Audit & Verification Report (Pass 3 of 3)
- **Audit Result**: **PASS**.
- **Verification Findings**:
  1. **Ownership & Boundaries**: All 8 services have precise, non-overlapping responsibilities, explicit data ownership, allowed dependencies, and forbidden dependencies.
  2. **Modular Monolith Deployment**: Confirmed that the application is architected as a modular monolith with zero unnecessary microservice network overhead.
  3. **Determinism & Persistence**: State evaluation (Narrative Engine) is strictly decoupled from database persistence transactions.
  4. **AI/Media Isolation**: AI and media adapters (`IntfAIGateway`, `IntfMediaGateway`) are isolated and prohibited from mutating Canon Data or bypassing domain services.
  5. **Future Scope Protection**: Future simulation (Tiers 1–3), multiverse, and Overseer features remain cleanly bounded as optional extensions without hidden MVP dependencies.
  - **Remaining Gaps**: None.
