# Phase 7 & 8: Detailed System Design & Internal System Blueprint — Re:NeWrld

Governed by **Project Growth v1.1.0**.

---

## 1. Introduction & Authority
This document defines the authoritative domain models, schemas, API contracts, condition evaluation grammar, state-transition rules, and publishing validation contracts for **Re:NeWrld**. All implementation code and system services developed in subsequent phases **must** strictly obey these contracts.

---

## 2. Domain Model & Schema Boundaries (Canon vs. Experience)
The data architecture is strictly bifurcated into two foundational domains:
- **Canon Data (Authoritative Baseline Truth)**: Owned by the Creator. Comprises world metadata, character profiles, flexible narrative roles, locations, factions, lore, chapters, scenes, prose blocks, and discrete choices. Stored in relational tables enforcing foreign key constraints and publishing validation rules. Published Canon is immutable *within a specific published version* and cannot be mutated by runtime reader choices, reader state, autonomous systems, or AI. Creators remain authorized to create governed new Canon versions through authoring and publishing updates, while historical reader timelines remain bound to the Canon version under which their experiences occurred.
- **Experience Data (Reader Runtime State)**: Owned by the Reader. Comprises active session state, inventory items, relationship trust scores, custom state flags, timeline progression history, and save checkpoints. Stored in isolated runtime session records.

---

## 3. Identifiers, References, Versioning & Serialization
- **Stable Identifiers**: All primary entities (`world_id`, `character_id`, `chapter_id`, `scene_id`, `choice_id`, `reader_id`, `session_id`) use universally unique identifiers (UUID v4 or ULID) to ensure distributed safety and stable cross-reference references.
- **Referential Integrity**: Foreign keys enforce that choices reference valid scenes within the same world ID scope.
- **Versioning Rules**: Published worlds maintain version snapshots. Active reader sessions are bound to the published version active at session initialization, ensuring author updates to published worlds do not corrupt or invalidate historical reader timelines.
- **Serialization Rules**: All API request/response payloads and database JSONB attribute bundles serialize to strict JSON conforming to authoritative **Zod** runtime schemas.

---

## 4. Flexible Character Roles & Arbitrary Genre Support
- **Arbitrary Genres**: Schemas support any genre or hybrid format (sci-fi, fantasy, historical, thriller, mystery, romance, cyberpunk, horror, literary, or cross-genre hybrids) via flexible world metadata tags and custom setting parameters.
- **Flexible Character & Role Schemas (`CharacterRoleSchema`)**:
  - `character_id`: UUID
  - `world_id`: UUID
  - `name`: string
  - `role_type`: enum (`protagonist`, `antagonist`, `companion`, `rival`, `villain`, `faction`, `custom`)
  - `description`: string
  - `attributes`: JSONB (goals, fears, initial relationship baselines, custom traits)
  - For MVP, the creator designates the initial reader-facing protagonist/character role.

---

## 5. Formal Deterministic Condition Model
Conditions required to unlock choices are evaluated deterministically using an expression syntax tree validated via Zod schemas:
- **Supported Operators**:
  - Comparison operators: `==`, `!=`, `>`, `<`, `>=`, `<=`
  - Logical operators: `AND`, `OR`
  - Domain checks: `inventory.has(item_id)`, `state.flag_is_true(flag_name)`, `relationship.get(character_id) >= threshold`
- **Evaluation Contract**: Condition evaluation is pure, side-effect-free, and executes entirely without AI intervention.

---

## 6. State-Transition Contract & Atomic Rollback
When a reader selects a choice (`choice_id`):
1. **Validation**: The backend retrieves current Reader State and evaluates the choice's condition rules against it. If conditions fail, the request is rejected with a 400 Bad Request.
2. **Atomicity & Transactionality**: State mutations (inventory additions, trust adjustments, flag toggles) and timeline history recording execute within a single database ACID transaction.
3. **Atomic Rollback on Persistence Failure**: If storage persistence fails during state mutation or scene transition, the transaction rolls back completely, preventing silent partial state corruption, and returns a 500 Internal Server Error with a standardized error envelope.
4. **Scene Transition**: Upon successful persistence, the engine resolves the target scene and returns the next scene payload to the reader.

---

## 7. Publishing Validation Contract
Before a draft world status updates to `Published`, the publishing validator executes automated checks:
- **Target Reachability**: Verifies that every `target_scene_id` referenced by a choice actually exists within the world.
- **Orphan Detection**: Identifies scenes that cannot be reached from any chapter entry point.
- **Ending Reachability**: Verifies that at least one valid terminal ending node (`ending: true`) is reachable from graph traversal.
- **Reference Integrity**: Validates that condition rules and mutation effects reference valid items, flags, and character IDs.
- **Rejection**: If any validation check fails, publication is rejected with a detailed validation error report.

---

## 8. REST API Contracts (Design Level)
All API requests and responses enforce strict Zod runtime schema validation.

### 8.1 Standardized Response Envelope
- **Success Response (`200 OK` / `201 Created`)**:
  ```json
  {
    "success": true,
    "data": { ... },
    "error": null
  }
  ```
- **Error Response (`4xx` / `5xx`)**:
  ```json
  {
    "success": false,
    "data": null,
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Detailed error description",
      "details": [ ... ]
    }
  }
  ```

### 8.2 Core Endpoints (MVP)
1. **Creator Authoring**:
   - `POST /api/v1/worlds` (Create world metadata)
   - `POST /api/v1/worlds/{world_id}/characters` (Author character/role)
   - `POST /api/v1/worlds/{world_id}/chapters` (Author chapter/scene)
   - `POST /api/v1/worlds/{world_id}/publish` (Trigger publishing validation)
2. **Creator Preview**:
   - `POST /api/v1/worlds/{world_id}/preview/evaluate` (Simulate path & test conditions)
3. **Reader Execution**:
   - `GET /api/v1/catalog/worlds` (Browse published worlds)
   - `POST /api/v1/sessions` (Initialize reader reading session)
   - `POST /api/v1/sessions/{session_id}/choices` (Submit choice selection, execute state mutation, and transition scene)
   - `GET /api/v1/sessions/{session_id}/character-sheet` (Inspect inventory, relationships, and flags)

---

## 9. JSONB Bounded Usage Contracts
PostgreSQL JSONB columns are restricted strictly to flexible authoring payload attributes (condition criteria dictionaries, mutable experience state variable maps, and styling metadata). **JSONB payloads cannot bypass authoritative domain contracts or Canon/Experience separation.** Every JSONB payload must pass strict runtime Zod validation before database insertion or state update.

---

## 10. MVP vs. Future Extension Points
- **MVP Contracts**: Deterministic core engine schemas, relational Canon tables, isolated Experience session tables, discrete choice condition rules, and publishing validator.
- **Future Extension Points (Tiers 1–3, Multiverse, Overseer)**: Schemas are designed with extensible JSONB metadata buckets and versioned hooks to support future Knowledge/Information tracking, NPC agency, timeline echoes, and optional Overseer metadata without breaking MVP table structures.

---

## 11. Unresolved Contract Decisions (Pending Implementation)
1. Exact syntax grammar for complex nested boolean condition expressions (deferred to Phase 8 implementation syntax parser design).
2. Specific indexing strategy for high-frequency reader state writes (deferred to database tuning in Phase 8).

---

## 12. Internal System Blueprint (Phase 8 — Pass 1 of 3)

### 12.1 Frontend Architecture (React + TypeScript)
- **Component Hierarchy**: Modular layout featuring Creator Dashboard (world management, scene editor, publishing control, preview simulation) and Reader Client (catalog browser, distraction-free reader interface, character sheet modal).
- **State Management**: Local component state for UI authoring forms; client data synchronization layer for reader sessions and authoring drafts.
- **API Client Boundary**: Centralized typed API client enforcing Zod request/response serialization matching backend contracts.

### 12.2 Backend Service & Module Boundaries (Node.js + Fastify)
- **Auth Module**: Session cookie management, RBAC middleware enforcing Creator vs. Reader role separation.
- **Authoring Module**: World, character, chapter, and scene CRUD operations with relational integrity.
- **Deterministic Narrative Engine Module**: Choice condition evaluation, state mutation processing, and scene graph navigation.
- **Publishing Validator Module**: Automated graph traversal validating target reachability, orphan detection, ending node reachability, and condition/mutation integrity.
- **Reader Session Module**: Session initialization, atomic state transitions, persistence error rollback handling, and character sheet inspection.

### 12.3 Allowed & Forbidden Dependencies (Dependency Direction)
- **Allowed Direction**: Presentation / UI → API Client → Fastify API Routes → Domain Services → Repositories → PostgreSQL Database.
- **Forbidden Dependencies**:
  - UI components must never communicate directly with the database or repository layers.
  - AI presentation modules must never mutate core state variables or override canon rules.
  - Standalone MVP stories must never depend on future multiverse or Meta-Narrative systems.

### 12.4 Data Classification
- **Canon Data**: Worlds, characters, roles, chapters, scenes, choices, ending nodes (relational tables, version-immutable).
- **Experience Data**: Reader sessions, inventory, trust scores, flags, timeline progression history (isolated runtime session tables).
- **Derived / Presentation Data**: AI-flavored prose rendering, catalog summaries, preview simulation logs (ephemeral).
- **Future Simulation Data**: Tier 1–3 world simulation variables, echoes, and cross-timeline artifacts (reserved schema buckets for Post-MVP).

### 12.5 Major Runtime Workflows & State Transitions
- **Reader Choice Execution Workflow**:
  1. Reader submits `choice_id`.
  2. Reader Session Service calls Narrative Engine.
  3. Narrative Engine validates conditions against Reader State.
  4. Within an ACID transaction, state mutations apply, timeline history records, and state persists. On failure, transaction rolls back.
  5. Target scene payload returns to reader.
- **Publishing Workflow**:
  1. Creator triggers publish on `world_id`.
  2. Publishing Validator traverses scene graph.
  3. If structural checks pass, status updates to Published and a version snapshot is locked. If checks fail, publication is rejected with structured errors.
- **Creator Preview Simulation**:
  - Isolated simulation endpoint (`/preview/evaluate`) allows creators to test condition evaluation and scene navigation without modifying or polluting live reader sessions.

---

## 13. Detailed Security, Observability, Testing & Future Extensibility (Phase 8 — Pass 2 of 3)

### 13.1 Security Enforcement Points
- **Authentication & RBAC**: Fastify middleware enforces HttpOnly secure session cookies and validates role boundaries (Creator vs. Reader).
- **Creator Ownership & Tenant Isolation**: All queries enforce `world_id` and creator user ID scoping, preventing unauthorized access to unpublished or published story worlds.
- **Reader Session Isolation**: Reader sessions are strictly scoped to `reader_id`, guaranteeing private progress.
- **Canon Protection**: Published Canon versions are immutable; runtime mutations only affect isolated Experience data.
- **Input Sanitization & Zod Validation**: All requests pass through Zod schema validation; external inputs are scrubbed against prompt injection vectors (AI-03).

### 13.2 Observability & Audit Responsibilities
- **Pino Structured Logging**: Fastify native JSON logging with unique request correlation IDs for distributed tracing.
- **Audit Logging**: Publishing actions, account authentication events, authorization rejections, and state transition transactions generate structured audit logs.

### 13.3 Testing Architecture & Responsibilities
- **Unit Testing**: Vitest unit test suite for the deterministic engine and publishing validator, paired with PostgreSQL Testcontainers for verifying ACID persistence, transaction rollbacks, and relational constraints.
- **Integration Testing**: PostgreSQL Testcontainers testing ACID state mutations, transaction rollbacks on persistence failure, and foreign key publishing constraints.

### 13.4 Future Extensibility Boundaries (Tiers 1–3)
- **Tier 1 (Foundational Simulation & Dynamics)**: Knowledge tracking, NPC Autonomy, relationships, time simulation, reputation, and secrets.
- **Tier 2 (Emergent Mechanics & Social Systems)**: Exploration, quests, inventory history, character development, death/legacy, and social dialogue.
- **Tier 3 (Living Multiverse & Overseer Layer)**: Living World Engine, cross-timeline gameplay, timeline artifacts, NPC timeline travel, collisions, and optional Overseer metadata.
- **Safety Rules**: Autonomous simulation events generate Experience/Timeline records unless explicitly authorized into a new Canon version via creator versioned publishing. Standalone MVP stories never depend on future simulation layers.

---

## 14. Detailed Runtime & Integration Lifecycle Design (Phase 8 — Pass 3 of 3)

### 14.1 API-to-Service-to-Domain-to-Persistence Flow
- **Request Flow**: Incoming HTTP requests arrive at Fastify routes → Authenticated via Session/RBAC middleware → Validated against authoritative Zod schemas → Handled by Domain Service (e.g., ReaderSessionService) → Executes business rules via Deterministic Narrative Engine → Persists state via Repository boundary into PostgreSQL within an ACID transaction.
- **AI Gateway & Media Gateway Boundaries**:
  - `IntfAIGateway`: Optional presentation layer interface for prose styling and dialogue flavoring. If disabled or failing, the core engine seamlessly falls back to pure authored prose without error.
  - `IntfMediaGateway`: Pluggable storage gateway backed by S3-compatible object storage with strict MIME validation for media assets.

### 14.2 Configuration, Caching & Indexing Responsibilities
- **Configuration**: Validated at server startup using Zod environment schemas (fail-fast startup).
- **Caching**: Fastify in-memory caching for static published catalog metadata.
- **Indexing**: PostgreSQL native B-Tree indexing on foreign keys and tenant scopes, with GIN indexing on JSONB condition payloads.

### 14.3 Transaction Ownership, Failure Handling & Idempotency
- **Transaction Ownership**: Domain services own transactional boundaries, utilizing PostgreSQL transaction hooks managed by the repository layer.
- **Idempotency**: Client-supplied idempotency keys on choice execution requests prevent duplicate state mutations during network retries.
- **Failure Handling**: If persistence fails, ACID transactions roll back completely, preventing partial state corruption and returning standardized error envelopes.

### 14.4 End-to-End Request & State-Transition Lifecycle
1. **Client Request**: Reader clicks choice; client sends POST request with `session_id`, `choice_id`, and request ID correlation header.
2. **Edge & API Gateway**: Request validated via Zod; session authenticated via secure HttpOnly cookie.
3. **Domain Service**: ReaderSessionService loads active session bound to immutable published story version.
4. **Narrative Engine**: Evaluates choice condition rules deterministically.
5. **Persistence**: State mutations and timeline progression record in a PostgreSQL ACID transaction.
6. **Response**: Target scene payload returned with success envelope.
