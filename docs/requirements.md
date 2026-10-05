# Phase 2: Requirements — Re:NeWrld

Governed by **Project Growth v1.1.0**.

---

## 1. Introduction & Scope Classification
This document defines the formal requirements for **Re:NeWrld**. All requirements are strictly categorized into:
- **[MUST]**: Mandatory requirements for MVP release.
- **[SHOULD]**: Desirable enhancements for MVP if time permits, or post-MVP priorities.
- **[FUTURE]**: Explicitly deferred capabilities for future iterations.

---

## 2. Functional Requirements

### 2.1 Creator World-Building & Authoring
- **FR-01 [MUST]**: Creators MUST be able to define world metadata across arbitrary genres and hybrid formats (title, description, setting rules, overarching tone).
- **FR-02 [MUST]**: Creators MUST be able to create and manage character profiles and narrative roles (including single or multiple protagonists, antagonists, companions, rivals, villains, factions, and other creator-defined roles, with the creator establishing the initial reader-facing protagonist/character role for MVP) and world items/flags.
- **FR-03 [MUST]**: Creators MUST be able to author chapters and narrative scenes containing prose (narration and dialogue).
- **FR-04 [MUST]**: Creators MUST be able to attach structured discrete choices to narrative scenes, defining deterministic conditional requirements (comparisons, boolean AND/OR, inventory/state checks, relationship thresholds) and state-mutation effects.
- **FR-05 [MUST]**: Creators MUST be able to trigger an automated publishing validation check that verifies referenced targets exist, detects orphaned/unreachable scenes, ensures at least one valid terminal ending node is reachable, validates condition/mutation references, and rejects structurally invalid publications.
- **FR-06 [FUTURE]**: Creators MUST NOT rely on unauthored real-time generation for core plot arcs; future collaborative authoring or package export/import capabilities [FUTURE] may be supported post-MVP.

### 2.2 Reader Experience & State Engine
- **FR-07 [MUST]**: Readers MUST be able to read authored narrative prose in a clean, distraction-free interface.
- **FR-08 [MUST]**: Readers MUST be presented with available structured choices at designated decision points based on deterministic evaluation of current reader state against choice condition requirements.
- **FR-09 [MUST]**: Selecting a choice MUST deterministically update persistent reader state (inventory, relationship values, custom flags/counters) and transition to the next linked scene.
- **FR-10 [MUST]**: The core narrative and state engine MUST function entirely deterministically using authored content without requiring an AI model.
- **FR-11 [SHOULD]**: Readers SHOULD be able to inspect their current inventory, relationship standings, and active state flags through a character sheet view.
- **FR-12 [FUTURE]**: Readers SHOULD be able to bookmark scenes, save/load multiple playthrough slots, and view branching history trees.

---

## 3. Non-Functional Requirements

### 3.1 Performance
- **NFR-01 [MUST]**: State evaluation and scene transition resolution MUST complete in under 100ms when tested under standard baseline single-user benchmark conditions.
- **NFR-02 [SHOULD]**: Page/scene load times for readers SHOULD be under 500ms.

### 3.2 Reliability & Availability
- **NFR-03 [MUST]**: Reader state changes MUST be durably recorded and persisted immediately upon choice selection to prevent data loss.
- **NFR-04 [SHOULD]**: The platform SHOULD target 99.9% uptime during standard operational hours under normal provisioned load.

### 3.3 Scalability
- **NFR-05 [SHOULD]**: The data architecture SHOULD support concurrent reading sessions across multiple published story worlds without state race conditions.

---

## 4. Security & Data Privacy Requirements
- **SEC-01 [MUST]**: Creator-authored intellectual property (Canon, unpublished scenes, world bibles) MUST be strictly protected against unauthorized read/write access.
- **SEC-02 [MUST]**: Reader journey states and personal progress data MUST be isolated per reader account.
- **SEC-03 [MUST]**: Input validation MUST be enforced on all authoring forms and choice submissions to prevent injection attacks and malformed state mutations.
- **SEC-04 [MUST]**: Role-Based Access Control (RBAC) MUST strictly separate Creator permissions from Reader permissions to prevent unauthorized story modification.

---

## 5. AI-Specific Requirements (Optional Presentation Layer)
- **AI-01 [MUST]**: AI features MUST remain strictly optional; disabling or omitting AI model integration MUST NOT impair core deterministic reading, branching, or state-tracking functionality.
- **AI-02 [MUST]**: AI presentation layers (prose styling, tone adaptation, contextual dialogue flavor) MUST operate strictly under creator-defined Canon rules and must not overwrite core story state or logic.
- **AI-03 [MUST]**: The architecture MUST enforce untrusted-input isolation and bounded AI authority, preventing external data or reader inputs from bypassing state rules, executing arbitrary code, or overriding canon governance.
- **AI-04 [SHOULD]**: Token usage and API call limits SHOULD be governed per session to control operational costs.

---

## 6. Data & State Requirements
- **DATA-01 [MUST]**: Clear separation MUST be maintained between **Canon Data** (creator-authored world assets that serve as authoritative baseline truth, subject to versioned author edits and updates) and **Experience Data** (reader-specific runtime variables and session state).
- **DATA-02 [MUST]**: Schema definitions MUST support deterministic serializability of reader state for reliable saving and loading.
- **DATA-03 [SHOULD]**: State migration pathways SHOULD be supported for authored stories receiving non-breaking author updates.

---

## 7. Accessibility Requirements
- **ACC-01 [MUST]**: The reader interface MUST support high contrast modes, adjustable font sizes, and full keyboard navigation (WCAG 2.1 AA compliance).
- **ACC-02 [SHOULD]**: Screen readers SHOULD correctly parse reading prose, UI navigation elements, and choice prompts.

---

## 8. Platform & Hosting Constraints
- **PLT-01 [MUST]**: The application MUST run as a modern web-accessible platform compatible with standard evergreen desktop and mobile browsers.
- **PLT-02 [SHOULD]**: The codebase SHOULD be structured for flexible deployment (containerized or cloud-native hosting).

---

## 9. External Integration & Cost Constraints
- **INT-01 [SHOULD]**: External LLM integrations (when enabled) SHOULD support pluggable provider abstractions (e.g. standard API interfaces).
- **CST-01 [MUST]**: Core hosting and deterministic execution costs MUST remain near-zero when operating without AI features enabled.

---

## 10. Licensing & Compliance Constraints
- **LIC-01 [MUST]**: All open-source dependencies used in the project MUST possess compatible permissive licenses (e.g., MIT, Apache 2.0).

---

## 11. Resolved MVP Product Decisions
- **Protagonist Identity & Character Roles Model**: MVP supports arbitrary genres and hybrid narrative formats. Creators define flexible narrative roles (protagonists, antagonists, companions, rivals, villains, factions, custom roles). MVP readers step into the initial reader-facing protagonist defined by the creator (preset protagonist profile); custom protagonist creation is deferred to Post-MVP/Future.
- **Choice Structure & Input Type**: MVP choices are strictly discrete authored option buttons; free-text input evaluation is excluded from MVP.
- **Relationship Mechanics & Gating**: MVP conditions use a deterministic rule system (comparisons, boolean AND/OR, inventory/state checks, relationship thresholds) rather than AI judgment. Formal grammar syntax is finalized during Contracts & Schemas.
- **Formal Ending Criteria**: MVP stories require explicit authored terminal/ending nodes. Reaching a terminal node completes the reader's journey.
- **Publishing Validation**: Mandatory automated validation checks must verify referenced targets, detect unreachable/orphaned scenes, verify reachable endings, validate condition/mutation references, and reject invalid publications.
