# Phase 10: Intelligence Design (Pass 1, 2 & 3 Audit) — Re:NeWrld

Governed by **Project Growth v1.1.0** and [`docs/governance.md`](governance.md).

---

## 1. Introduction & Authority
This document defines the authoritative **Intelligence Architecture** for **Re:NeWrld**, establishing strict boundaries between **Deterministic System Intelligence** (the core deterministic engine responsible for absolute game state, branching logic, condition evaluation, and publishing validation) and **Optional AI Intelligence** (the generative presentation layer responsible for prose styling, tone adaptation, and dialogue flavoring). 

All implementation code developed in subsequent phases **must** strictly obey these intelligence separation rules.

---

## 2. Core Separation Principle: System Intelligence vs. AI Intelligence
- **Deterministic System Intelligence**: Owns absolute domain logic, condition rules, variable mutations, referential integrity, and Canon validity. Operates 100% reliably without requiring any artificial intelligence model.
- **Optional AI Intelligence (`IntfAIGateway`)**: Operates strictly as a bounded presentation wrapper. It receives authorized narrative blocks and reader state context, rendering stylized prose or dynamic dialogue flavoring. It has **zero authority** over game logic, state mutations, or Canon validity.

---

## 3. Intelligence Component Specifications (MVP Core)

### 3.1 Deterministic Condition Evaluation Engine
- **Responsibility**: Pure, side-effect-free evaluation of choice condition rules against active Reader State.
- **Inputs**: Choice condition criteria (Zod validated schema), current Reader State (`inventory`, `relationships`, `flags`).
- **Outputs**: Boolean determination (`true` / `false`) indicating whether a choice is unlocked.
- **Authority Limits**: Absolute authority over condition gating. AI has zero input or veto power.
- **Allowed Data Access**: Active Reader State session data.
- **Forbidden Actions**: Must never modify state variables or query external LLM endpoints.
- **Failure Behavior**: If condition evaluation encounters a malformed rule, it defaults to locked (`false`) and logs a structured warning.

### 3.2 State Transition Processor
- **Responsibility**: Executing atomic state mutations (inventory adjustments, relationship trust updates, state flag toggles) and recording timeline history within an ACID database transaction.
- **Inputs**: Selected `choice_id`, active session ID, current Reader State.
- **Outputs**: Updated Reader State, target scene ID payload.
- **Authority Limits**: Absolute authority over runtime reader state mutations.
- **Allowed Data Access**: Reader session records, persistence repository.
- **Forbidden Actions**: Must never mutate creator Canon Data.
- **Failure Behavior**: If persistence fails, the entire transaction rolls back atomically, preventing partial state corruption and returning a standardized 500 error envelope.

### 3.3 Publishing Validation Engine
- **Responsibility**: Automated graph traversal validating target scene reachability, orphan detection, ending node reachability, and referential integrity before a draft world becomes Published.
- **Inputs**: Draft world ID, associated chapters, scenes, choices, and condition/mutation rules.
- **Outputs**: Publishing validation report (success or structured list of structural errors).
- **Authority Limits**: Absolute gating authority over world publication.
- **Allowed Data Access**: Draft Canon Data assets for the specified world ID.
- **Forbidden Actions**: Must not modify draft records or access active reader runtime states.
- **Failure Behavior**: If validation fails, publication is rejected; draft status remains unchanged.

### 3.4 Narrative Resolution Engine
- **Responsibility**: Detecting terminal ending nodes (`ending: true`) and generating journey completion summaries.
- **Outputs**: Terminal ending status, final session statistics.
- **Authority Limits**: Absolute authority over story completion detection.
- **Allowed Data Access**: Current scene metadata and reader timeline history.
- **Failure Behavior**: Defaults to non-terminal state if node metadata is ambiguous.

### 3.5 AI Presentation Layer (`IntfAIGateway`)
- **Responsibility**: Optional enhancement layer rendering prose styling, tone adaptation, and contextual dialogue flavoring based on current reader state and creator Canon rules.
- **Inputs**: Authored scene prose, creator tone guidelines, current Reader State summary, and prompt-injection-scrubbed contextual strings.
- **Outputs**: Stylized narrative prose text or dynamic dialogue rendering.
- **Authority Limits**: **Strictly bounded presentation authority**. Prohibited from mutating core state variables, overriding condition results, or rewriting creator Canon.
- **Allowed Data Access**: Sanitized prompt context and read-only scene text.
- **Forbidden Actions**: Must never execute database mutations, execute code, or bypass domain services.
- **Failure Behavior**: If the AI gateway times out, errors, or produces output violating Canon boundary checks, the system seamlessly falls back to pure creator-authored prose without interrupting reader progression.

---

## 4. Future Intelligence Boundaries: Tiers 1–3 Simulation & NPC Agency (Pass 2 of 3)

### 4.1 Future Extensibility Scope (Post-MVP)
To support advanced simulation, living worlds, and multiverse features in future tiers (Tiers 1–3), the intelligence architecture defines strict boundaries for autonomous NPC behavior, knowledge tracking, relationships, time simulation, and consequence engines. **These capabilities are strictly future-only and optional, never becoming hidden MVP dependencies.**

### 4.2 Autonomous Decision-Making & Author-Governed Constraints
- **Creator-Authored Constraints**: Autonomous NPC decisions and emergent world events are strictly governed by creator-authored character profiles, goals, knowledge limits, abilities, relationship baselines, moral boundaries, and behavioral rules.
- **Objective Truth vs. Character Perception**: The architecture explicitly separates **Objective World Truth** (stored in world state tables) from **Character Knowledge, Belief, and Perception** (runtime character state tables). NPCs act only on what they know or observe, preventing omniscience and enabling secrets, deception, and investigation mechanics.
- **Simulation Outcomes as Experience Events**: Autonomous simulation events, NPC actions, and emergent world outcomes generate **Runtime Experience / Timeline events** for the individual reader session. They *never* mutate creator Canon Data unless explicitly authorized through a governed, versioned author publishing update.
- **Operational Division (Deterministic Rules vs. Simulation vs. AI Reasoning)**:
  - **Deterministic Rules**: Handle absolute condition evaluation, gating, and state updates.
  - **Simulation Logic**: Handle procedural world clocks, reputation decay, and NPC schedule movement.
  - **AI Reasoning**: Optional bounded reasoning wrappers that interpret NPC goals against current world context to suggest dialogue or reactive dialogue flavoring, strictly constrained by creator character sheets. AI is permanently prohibited from inventing authority, new abilities, unauthored Canon, or permissions.

---

## 5. Intelligence Security, Authority, Provenance & Containment (Pass 3 of 3)

### 5.1 Cross-Timeline & Overseer Security Boundaries
- **Cross-Timeline Isolation**: Cross-timeline intelligence (reusable outcome pools, timeline echoes, artifacts) remains strictly isolated behind creator opt-in configuration and reader consent frameworks. Standalone MVP stories have zero dependency on cross-timeline systems.
- **Optional Overseer Authority**: The platform meta-narrative / Overseer intelligence layer is **strictly optional, creator-opt-in, explicitly permissioned, fully auditable, and never a hidden platform backdoor**. It can never override creator Canon or reader state without explicit authorization.

### 5.2 Provenance, Auditability & Attribution
- All autonomous simulation events, AI-assisted authoring suggestions, and presentation transformations generate structured audit logs tagged with correlation IDs, tracing exact provenance.
- AI actions are fully attributable and bounded by strict permission constraints, ensuring artificial intelligence systems cannot silently gain authority or alter underlying rules.

### 5.3 Failure & Containment Boundaries
- If any future simulation worker or AI reasoning wrapper encounters anomalies, exceptions, or boundary violations, execution is safely contained within isolated sandbox threads, defaulting to pure deterministic fallback behavior without affecting active reader sessions.

---

## 6. Phase 10 Intelligence Design Audit & Verification Report (Pass 3 of 3)
- **Audit Result**: **PASS**.
- **Verification Findings**:
  1. **System vs. AI Intelligence**: Strict separation is established where Deterministic System Intelligence owns absolute domain logic and Canon, while AI intelligence (`IntfAIGateway`) operates strictly as a presentation wrapper.
  2. **Core Components**: Condition evaluation, state transitions, publishing validation, and narrative resolution are fully specified with explicit inputs, outputs, authority limits, and failure behaviors.
  3. **Future Tiers 1–3**: Simulation, NPC agency, objective truth vs. perception, and cross-timeline outcomes are properly scoped as future-only Experience events without altering MVP requirements.
  4. **Security & Containment**: Cross-timeline and Overseer systems maintain strict isolation and creator opt-in guarantees.
- **Design Gate Status**: **PASS** (pending Phase B2 implementation execution).
