# Phase 5: System Architecture — Re:NeWrld

Governed by **Project Growth v1.1.0**.

---

## 1. System Overview & Architectural Principles
**Re:NeWrld** is architected around a strict separation of concerns that unifies authorial control with personalized reader agency. The core platform is designed to operate entirely deterministically without requiring an artificial intelligence model, ensuring 100% testable state fidelity and predictable execution.

### Key Architectural Principles
- **Canon vs. Experience**: Absolute separation between author-defined baseline truth (Canon) and individual runtime reader journeys (Experience). Published Canon is immutable *within a specific published version* and cannot be mutated by runtime reader choices, reader state, autonomous systems, or AI; creators remain authorized to create governed new Canon versions through authoring and publishing updates, ensuring historical reader timelines remain bound to the version under which their sessions were initialized.
- **AI-Independent Core Engine**: The state machine, branching logic, conditional checks, variable tracking, and narrative progression are fully deterministic and function independently of AI.
- **AI as Presentation Layer**: AI functions strictly as an optional enhancement and linguistic/visual presentation layer. It never owns story logic, state authority, or canon validity.
- **Backend Determinism**: *"Mystery to the reader does not mean uncertainty in authoritative backend rules."* Stochastic prose flavoring never alters deterministic backend state.
- **Strict Isolation**: Complete cross-story isolation ensures authored worlds and reader sessions remain tenant-segregated.

---

## 2. Trust Boundaries & Security Zones
1. **Creator Workspace Zone**: Authenticated environment for authors to manage Canon assets, author chapters/scenes, configure rules, and run publishing validations.
2. **Reader Runtime Zone**: Authenticated environment where readers browse catalogs, initialize sessions, read prose, evaluate choices, and mutate persistent state.
3. **Public Catalog Zone**: Unauthenticated read-only access to published story listings and metadata.
4. **Platform Administration & Moderation Zone**: Restricted zone for platform operators and moderators to handle compliance, reporting, and safety actions.

---

## 3. Major Subsystems & Service Boundaries (The 8 Conceptual Layers)

### 3.1 Creator Canon Subsystem
- **Responsibility**: Manages immutable and versioned creator assets (world metadata, character profiles, narrative roles, locations, factions, and lore).
- **Boundary**: Owned exclusively by the Creator. Read-only during active reader sessions.

### 3.2 World Rules Subsystem
- **Responsibility**: Houses universal world rules, power systems, condition evaluation formulas, and validation constraints.
- **Boundary**: Deterministic rule parser operating independently of presentation layers.

### 3.3 Story Structure Subsystem
- **Responsibility**: Manages chapters, narrative prose blocks, structured discrete choices, and terminal ending nodes.
- **Boundary**: Immutable authored graph structure verified by the publishing validation pipeline.

### 3.4 Reader State Subsystem
- **Responsibility**: Tracks persistent runtime session variables (inventory, trust/relationship scores, custom flags/counters) for individual readers.
- **Boundary**: Private to the reader session; isolated per account with atomic persistence and rollback protection.

### 3.5 Timeline Experience Subsystem
- **Responsibility**: Manages the unique, procedural sequence of scenes, choices, and state transitions experienced by a reader.
- **Boundary**: Orchestrates scene presentation and choice evaluation using Story Structure and Reader State.

### 3.6 Narrative Resolution Subsystem
- **Responsibility**: Detects terminal ending nodes and manages journey completion summaries.
- **Boundary**: Purely deterministic evaluation of ending conditions.

### 3.7 AI/Media Presentation Subsystem (Optional Gateway)
- **Responsibility**: Handles optional generative prose styling, tone adaptation, dialogue flavoring, art illustrations, and dynamic audio/voice/SFX.
- **Boundary**: Bounded authority. Communicates through strict input/output contracts and never mutates core state or Canon.

### 3.8 Optional Cross-Timeline & Multiverse Layer (Future / Post-MVP)
- **Responsibility**: Manages shared outcome pools, timeline echoes, artifacts, and cross-timeline interactions.
- **Boundary**: Strictly opt-in, creator-configured, and reader-consented. **Never a hidden dependency for standalone stories.**

---

## 4. Future Extensibility: The Advanced Gameplay Model (Post-MVP Tiers 1–3)
To support the long-term vision of a living multiverse and deep simulation across arbitrary genres (realistic, mystery, horror, romance, drama, mythology, sci-fi, space, adventure, manga/anime-inspired, isekai, light novel, nonfiction, or hybrid/subgenre formats), the architecture defines future conceptual extensibility tiers. **These tiers are strictly Post-MVP / Future capabilities and do not alter MVP requirements.**

### 4.1 Future Gameplay Tiers
- **Tier 1 (Foundational Simulation & Dynamics)**: Knowledge/Information tracking, Character Agency & NPC Autonomy, Relationship networks, Time/World Simulation, Consequences/Reputation tracking, and Secrets/Truth mechanics.
- **Tier 2 (Emergent Mechanics & Social Systems)**: Exploration mechanics, Objectives/Quests, Inventory/Object History tracking, Character Development & Emergent Traits, Death/Legacy systems, and Social/Dialogue frameworks.
- **Tier 3 (The Living Multiverse & Overseer Layer)**: Living World Engine, Cross-Timeline Gameplay, Timeline Artifacts, NPC Timeline Travel, Timeline Investigation, Timeline Collisions, and optional Platform Meta-Narrative / Overseer gameplay.

### 4.2 Future Conceptual Boundaries & Simulation Rules
- **Creator Autonomy & Genre Flexibility**: Creators may select different simulation and autonomy depths (from zero NPC autonomy in traditional literary stories to highly autonomous living worlds in sandbox simulations) across any genre.
- **Simulation Boundary & Authority**: 
  - Creator-authored character/world rules define bounds.
  - Deterministic simulation and governed action evaluation process permitted actions.
  - Autonomous NPC decision-making and emergent events generate **Timeline Experience events** (runtime Experience data) and *never* mutate creator Canon unless explicitly authorized via versioned author edits.
  - AI and platform presentation layers are strictly prohibited from becoming unauthorized canon authorities, executing unconstrained AI authorship, or creating arbitrary abilities outside creator-defined constraints.
- **Support for Non-Autonomous Stories**: The architecture explicitly supports stories with zero NPC autonomy as well as fully autonomous living worlds without architectural friction.

---

## 5. Identity, Authentication & Authorization Boundaries
- **Authentication**: Secure credential management and session tokens establishing user identity.
- **Authorization (RBAC)**: Strict separation between **Creator** roles (authoring, publishing) and **Reader** roles (journey execution, state inspection). Unauthorized cross-role actions are rejected at the API boundary via Fastify RBAC middleware and secure HttpOnly cookies.

---

## 6. Persistence & Data Ownership Boundaries (Relational vs. JSONB)
- **Canon Data**: Owned by the Creator; stored in authoritative relational tables (worlds, characters, chapters, scenes, choices, ending nodes) enforcing foreign key integrity and publishing validation constraints.
- **Experience Data**: Owned by the Reader; stored in isolated runtime session records guaranteeing private journey persistence.
- **Relational vs. JSONB Boundaries**: PostgreSQL relational tables own core structural entities and publishing constraints. JSONB columns are strictly restricted to flexible payload attributes (such as condition rule criteria and mutable experience variable dictionaries). **JSONB payloads cannot bypass authoritative domain contracts or Canon/Experience separation; all JSONB data must pass strict runtime validation (Zod) before persistence.**
- **Cross-Tenant Isolation**: Database queries and caching layers enforce world ID and user ID scoping on every operation.

---

## 7. Deterministic Execution Core & State Transition Model
- **State Transition Flow**:
  1. Reader selects a discrete choice.
  2. State Engine evaluates choice condition requirements against current Reader State.
  3. If valid, state mutations execute atomically.
  4. State changes are durably persisted to storage with rollback protection on failure.
  5. Engine resolves target scene transition and returns next scene payload.

---

## 8. Publishing & Validation Pipeline
Before a draft world becomes Published, the publishing pipeline executes automated checks:
- Verifies that all referenced target scenes exist.
- Detects orphaned scenes (unreachable from the chapter start or entry points).
- Verifies that at least one valid terminal ending node is reachable.
- Validates condition and mutation references against world metadata and character profiles.
- Rejects structurally invalid publications.

---

## 9. AI Gateway & Media Pipeline Boundaries
- **Untrusted-Input Isolation**: All external data and reader inputs are sanitized against prompt injection before reaching AI wrappers.
- **Bounded Authority**: AI responses are validated against Zod schema contracts; fallback deterministic text is rendered if AI output violates canon rules.
- **Cost & Token Gating**: Session-level token governance prevents runaway API costs.

---

## 10. Privacy, Cross-Story Isolation & Operator Boundaries
- **Privacy**: PII minimization, reader journey encryption at rest and in transit, and right-to-be-forgotten deletion workflows.
- **Operator Boundaries**: Platform operators have operational access for maintenance but are strictly prohibited from altering creator Canon or reader Experience data without audit justification.

---

## 11. Failure, Recovery, Scalability & Observability
- **Resilience**: Exponential backoff and jitter for transient storage errors; atomic rollback on persistence failure.
- **Observability**: Unique request correlation IDs across all service calls and state transition logs via Pino structured logging.
- **Health Endpoints**: Dedicated `/healthz/live` and `/healthz/ready` probes.

---

## 12. Deployment Topology & Disaster Recovery
- **Topology**: Web client communicating via secure API boundaries with stateless application servers and durable managed PostgreSQL instances.
- **Hosting & CI/CD**: Containerized deployment on managed container infrastructure with GitHub Actions CI/CD pipeline automation.
- **Disaster Recovery**: Automated daily database backups with point-in-time recovery (PITR).

---

## 13. MVP vs. Post-MVP Architectural Distinction
- **MVP Architecture**: Deterministic core engine, creator authoring database, publishing validator, atomic reader state session store, Zod runtime validation, and optional AI presentation gateway.
- **Post-MVP / Future Architecture**: Collaborative multi-author workspaces, branching graph visualizers, shared outcome pools, cross-timeline echo propagation, optional AI art/audio pipelines, Tier 1–3 simulation engines, and creator marketplace integration.

---

## 14. Architectural Invariants & Forbidden Dependencies
- **Invariants**:
  - Deterministic state engine must function without AI.
  - Canon is absolute and immutable to runtime reader choices.
  - Reader state is strictly private and isolated.
  - NPC autonomy and simulation events generate Experience/Timeline records and never mutate creator Canon without explicit author version updates.
- **Forbidden Dependencies**:
  - UI components must never communicate directly with the database (must traverse service/engine boundaries).
  - AI presentation modules must never mutate core state variables or override canon rules.
  - Optional multiverse, Overseer, or simulation tiers must never become mandatory dependencies for standalone stories.

---

## 15. Major Risks & Unresolved Architectural Questions
- **Risk**: Branch and simulation complexity explosion in large post-MVP worlds. (Mitigated in MVP by publishing validator reachability checks).
- **Unresolved Architectural Questions** (Deferred to Contracts & Schemas / Technology Selection):
  1. Exact schema representation for hierarchical condition evaluation expressions.
  2. Optimal storage indexing strategy for high-frequency reader state persistence.
