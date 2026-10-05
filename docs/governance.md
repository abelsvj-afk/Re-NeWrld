# Phase 4: Governance, Safety & Authority — Re:NeWrld

Governed by **Project Growth v1.1.0** and [`governance/AI_AGENT_RULES.md`](../governance/AI_AGENT_RULES.md).

---

## 1. Introduction & Governance Scope
This document defines the comprehensive **Governance, Safety & Authority** specification for **Re:NeWrld**. It establishes clear authority boundaries, data protection rules, privacy frameworks, AI safety guardrails, and operational constraints across both MVP and future platform tiers.

Re:NeWrld operates on a foundational separation between **Authorial Intent & Canon** (creator control) and **Reader Agency & Experience** (personalized state-driven journeys), backed by an **AI-independent core engine** where AI serves strictly as an optional presentation layer.

---

## 2. Authority Hierarchy & Conceptual Tiers

### 2.1 Creator Authority
- **Definition**: Creators retain absolute ownership and editorial control over their authored story worlds, character profiles, lore bibles, chapters, scenes, and publishing cadence.
- **Rules**: Creators have full read/write/publish authority over their draft and published worlds. Creators can update published worlds through versioned author updates.

### 2.2 Canon Authority
- **Definition**: The authoritative baseline truth of a story world authored by the creator (world history, immutable lore, core character profiles, and milestone plot events).
- **Rules**: Published Canon is immutable *within a specific published version* and cannot be mutated by runtime reader choices, reader state, autonomous systems, or AI. Creators remain authorized to create governed new Canon versions through the authoring and publishing process, while historical reader timelines remain bound to the Canon version under which their experiences occurred.

### 2.3 World-Rule Authority
- **Definition**: The deterministic constraints, condition evaluation rules, and state-mutation logic governing story progression.
- **Rules**: World-rule logic is entirely deterministic. Condition evaluations and state mutations execute via unambiguous rule evaluation rather than probabilistic AI interpretation.

### 2.4 Story-Structure Authority
- **Definition**: Chapters, narrative prose blocks, structured discrete choices, and terminal ending nodes authored by the creator.
- **Rules**: Only creator-authored story structures define valid narrative progression paths. Automated publishing validation checks enforce that choice targets exist, orphaned scenes are detected, and at least one valid ending node is reachable.

### 2.5 Reader-State Authority
- **Definition**: Persistent runtime session variables tracking an individual reader's progress, inventory, relationship trust scores, and custom flags.
- **Rules**: Reader state is private to the reader session and isolated per account. State changes execute atomically with mandatory persistence failure handling and rollback protection.

### 2.6 Timeline Experience Authority
- **Definition**: The unique, procedural sequence of scenes, choices, and state mutations experienced by an individual reader.
- **Rules**: A reader's timeline is their own private journey. In future tiers where timelines interact, participation is strictly governed by creator configuration and reader opt-in consent.

### 2.7 Narrative-Resolution Authority
- **Definition**: Terminal ending nodes, outcome summaries, and story completion milestones.
- **Rules**: Story completion is determined exclusively by reaching an explicit authored terminal ending node. There is no AI-generated or inferred story completion.

### 2.8 AI/Media Presentation Authority
- **Definition**: Optional generative enhancement layers (prose styling, tone adaptation, dialogue flavoring, optional art illustrations, dynamic audio, and voice/SFX).
- **Rules**: AI functions strictly as an **optional enhancement and presentation layer**. AI is *prohibited* from owning story logic, state authority, or canon validity. Disabling AI features must never impair core deterministic reading, branching, or state tracking.

### 2.9 Cross-Timeline Authority (Future)
- **Definition**: The shared story multiverse comprising reusable outcome pools, timeline echoes, artifacts, and alternate selves.
- **Rules**: Cross-timeline phenomena are strictly governed by creator configuration (whether cross-timeline elements are permitted) and reader consent.

### 2.10 Optional Story-Multiverse Authority (Future)
- **Definition**: Inter-world or platform-wide narrative interactions across published worlds.
- **Rules**: Entirely optional, requiring explicit creator opt-in and strict cross-story boundary isolation.

### 2.11 Optional Platform Meta-Narrative / Overseer Authority (Future)
- **Definition**: A platform-level meta-narrative or administrative guidance layer.
- **Rules**: The Overseer concept is **strictly optional, creator-opt-in, explicitly permissioned, fully auditable, and never a hidden platform backdoor**. It can never override creator Canon or reader state without explicit authorization.

---

## 3. Platform, Operational, Moderation & Agent Authority

### 3.1 Platform & Operator Authority
- Platform operators maintain infrastructure availability, database durability, security patching, and compliance with data privacy regulations.
- Operators *cannot* alter creator Canon or reader personal data arbitrarily without valid audit or safety justification.

### 3.2 Moderation Authority
- Designated moderators and automated safety filters can flag, review, and remove published content or community discussions that violate platform terms of service, safety guidelines, or copyright rules.
- Moderation actions maintain full audit logs and appeal mechanisms for creators.

### 3.3 Agent Authority & AI Guardrails
- **Bounded Autonomy**: AI agents and coding assistants operate under strict bounded execution (read/prepare/validate).
- **Forbidden Agent Actions**: Agents are strictly prohibited from:
  - Making unauthorized architectural or product-direction changes (Level 3/4 changes require human approval).
  - Writing code or modifying implementation files without an approved design and active task.
  - Exposing, logging, or committing secrets or sensitive credentials.
  - Bypassing the System Completeness Gate or ignoring project instructions (`GEMINI.md`).
- **Human Approval Gates**: Autonomous destructive, financial, or irreversible actions are strictly forbidden without explicit human review.

---

## 4. Data Governance, Privacy, Consent & Ownership

### 4.1 Creator IP & Asset Protection
- Creator-authored Canon, unpublished drafts, and world bibles are strictly protected against unauthorized read/write access.
- Creators retain full ownership of their intellectual property.

### 4.2 Reader Privacy, Consent & Anonymization
- Reader journey states, personal notes, and reading progress are strictly private.
- In future cross-timeline or community sharing features, participation requires explicit **reader opt-in consent**.
- Shared timeline echoes or alternate outcomes are automatically anonymized to prevent PII exposure or unwanted identification.

### 4.3 Data Retention & Deletion (Right to Be Forgotten)
- Users (both Creators and Readers) possess the right to export or delete their account data and associated journey states upon request.
- Defined retention schedules ensure ephemeral session caches and logs are pruned securely.

---

## 5. Security, Safety & Abuse Prevention

### 5.1 Cross-Story Isolation
- The data architecture and tenancy model must ensure complete isolation between distinct authored story worlds, preventing cross-tenant data leaks or unauthorized state pollution.

### 5.2 Input Validation & Prompt Injection Defense
- Rigorous input sanitization and strict schema validation apply to all authoring forms, choice submissions, and API payloads.
- All external retrieved data and optional user inputs are treated as untrusted and scrubbed against prompt injection vectors before reaching any language model wrapper.

### 5.3 Auditability, Provenance & Reversibility
- Critical state mutations, publishing actions, and moderation decisions generate structured audit logs with correlation IDs.
- State persistence employs atomic transactions with rollback protection to ensure persistence failures never leave reader state corrupted or inconsistent.

---

## 6. Core Architectural Principle: Backend Determinism
- **Principle**: *“Mystery to the reader does not mean uncertainty in authoritative backend rules.”*
- **Explanation**: Even when AI presentation layers introduce stochastic prose styling, dynamic dialogue flavor, or atmospheric descriptions, the underlying game state, branch conditions, inventory checks, and relationship thresholds remain **100% deterministic, transparently evaluated, and fully testable**. Stochastic presentation never alters deterministic backend authority.

---

## 7. MVP vs. Future Governance Breakdown

| Governance Domain | MVP Scope | Post-MVP / Future Scope |
| :--- | :--- | :--- |
| **Canon & Authoring** | Creator-authored immutable/versioned baseline Canon; publishing validation checks. | Collaborative multi-author workspaces; governed AI writing assistants. |
| **State & Engine** | Fully deterministic core engine; atomic state persistence with rollback. | Replay checkpoints; branching history tree inspection. |
| **AI & Media** | Optional presentation layer; strict untrusted-input isolation. | Optional AI art, dynamic audio/voice/SFX, character consistency APIs. |
| **Sharing & Multiverse** | None (private single-player reading). | Reusable outcome pools, cross-timeline echoes, artifacts, and community multiverse. |
| **Moderation & Privacy** | Creator data isolation and reader account privacy. | Advanced community reporting, anonymized timeline sharing consent, and creator monetization controls. |

---

## 8. Remaining Governance Questions (Pending Future Resolution)
1. **Moderation SLA**: What specific automated vs. manual review turnaround times will be established for published story flagging?
2. **Cross-Timeline Opt-Out Granularity**: Will readers be able to opt out of sharing specific journey branches while opting into others, or is sharing toggleable globally per world?
