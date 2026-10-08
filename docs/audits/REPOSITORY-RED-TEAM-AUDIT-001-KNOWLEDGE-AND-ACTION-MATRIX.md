# REPOSITORY RED-TEAM AUDIT KNOWLEDGE & ACTION MATRIX (001)

- **Document ID**: REPOSITORY-RED-TEAM-AUDIT-001-KNOWLEDGE-AND-ACTION-MATRIX
- **Source Audit**: `docs/audits/REPOSITORY-RED-TEAM-AUDIT-001-CLAUDE.md`
- **Reconciliation Reference**: `docs/audits/REPOSITORY-RED-TEAM-AUDIT-001-RECONCILIATION.md`
- **Governing Workflow**: Project Growth Governance v1.1.0 / `workflows/MASTER_AI_ENGINEERING_WORKFLOW.md`

---

## 1. Executive Overview & Scope

This Knowledge & Action Matrix captures the exhaustive substantive findings across all sections (A through AD) of Claude's Independent Red-Team Audit of **Re:NeWrld**. It maps every domain—product, narrative, gameplay, UX, architecture, security, privacy, scalability, testing, operations, AI governance, and implementing-agent guidance—to its status, repository evidence, affected specifications, required decisions, and task/ADR mappings.

*Note on Overseer Mandate*: The established Re:NeWrld Overseer concept remains fully authoritative as intended by the project. The Overseer is the platform-owned authoritative meta-narrative entity, with the user retaining ownership and ultimate authority over its canon and operation. Claude’s recommendation to defer or split the Overseer does not override this established vision. However, Claude’s observations regarding permissions, auditability, bounded interventions, attribution, safety, and AI limits are incorporated as valuable engineering constraints around the Overseer.

---

## 2. Comprehensive Knowledge & Action Matrix

| Audit Domain & Ref | Finding / Claim Summary | Status | Evidence & Repository Location | Affected Docs / Specs | Required Decision / Trade-off | Action / Task / ADR Mapping |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Executive Assessment** | Production start crash, migration test container isolation, status document overclaims. | **CONFIRMED** | `package.json`, `scripts/migrate.ts`, `PROJECT_STATE.md`. | `PROJECT_STATE.md`, `Dockerfile`, `TASKS.md`. | Fix startup script and test runner isolation before deployment. | Corrective Task B2.1 (Fix start script & migration test runner). |
| **B. Product Thesis** | Canon-controlled interactive fiction platform bridging Twine branching and AI roleplay. | **ALREADY SATISFIED** | `docs/idea.md`, `docs/vision.md`. | `docs/idea.md`, `docs/vision.md`. | Maintain authority split (Canon vs. Experience). | Retain architectural direction. |
| **C. Strengths** | Crisp authority separation, optionality discipline, robust B2 foreign key constraints. | **ALREADY SATISFIED** | `db/migrations/001_initial_schema.sql`. | `docs/architecture.md`. | None (preserve existing robust design). | Maintain B2 schema strengths. |
| **D. Missing Foundations** | State-reactive prose, typed variable/fact registry, immutability enforcement, moderation. | **CONFIRMED** | `db/migrations/001_initial_schema.sql` (`scenes.prose`). | `docs/requirements.md`, `docs/detailed-design.md`. | Define deterministic prose interpolation and variable registry syntax. | New Design Docs (W1, W2), Task D0. |
| **E. Differentiation** | Platform governance and hosted distribution are real moats; AI-chat vs. choice-fiction audiences differ. | **HUMAN DESIGN DECISION REQUIRED** | `docs/architecture.md`. | `docs/vision.md`. | Balance creator distribution needs with reader expectations. | Product strategy alignment. |
| **F. Gameplay Red-Team** | Knowledge substrate, time, location, pacing, randomness policy, fail-forward under-specified. | **PARTIALLY CONFIRMED** | `docs/requirements.md`. | `docs/requirements.md`, `docs/detailed-design.md`. | Specify time, knowledge, and pacing mechanics before Tier 1 simulation. | Add gameplay specifications in Phase D/E. |
| **G. Narrative Red-Team** | Railroad/cosmetic choice risk, invisible state, convergence of branches without state-reactive prose. | **CONFIRMED** | `db/migrations/001_initial_schema.sql`. | `docs/detailed-design.md`. | Implement state-reactive text interpolation. | Task D2 (Dynamic Scene Rendering). |
| **H. Character / NPC Intelligence** | Static profiles lacking knowledge, goals, relationships, and action vocabularies. | **SUPERSEDED (Deferred to Tier 1+)** | `db/migrations/001_initial_schema.sql` (`characters`). | `docs/intelligence-design.md`. | Defer complex NPC autonomy to post-MVP Tier 1. | Keep out of MVP roadmap. |
| **I. World Simulation** | Simulation results belong in per-reader timelines, not shared Canon state. Pure function model (lazy evaluation). | **CONFIRMED** | `docs/intelligence-design.md`, `docs/architecture.md`. | `docs/intelligence-design.md`. | Model simulation as pure lazy function with provenance rule IDs. | Simulation Rules ADR & Policy (W6). |
| **J. Cross-Timeline / Multiverse** | Multiverse echoes require compatibility, spoiler horizons, privacy, rate/echo limits. | **SUPERSEDED (Deferred to Post-MVP)** | `docs/future-vision.md`. | `docs/future-vision.md`. | Keep cross-timeline features out of MVP. | Maintain post-MVP roadmap boundary. |
| **K. Overseer / Meta-Narrative** | Platform Overseer bundles creator Director with meta-narrative. User ownership retained; bounded interventions required. | **PARTIALLY CONFIRMED (User Mandate Applied)** | `docs/governance.md`, `docs/architecture.md`. | `docs/governance.md`. | Uphold user ownership of Overseer; enforce auditability and attribution. | Overseer Governance ADR & Audit Logging. |
| **L. AI Authority & Safety** | Risks of invented lore, phantom state, secret leakage, prompt injection, and unreproducible history. | **CONFIRMED** | `docs/threat-model.md`, `docs/architecture.md`. | `docs/threat-model.md`. | Enforce strict input filtering, entity allowlists, and state isolation. | AI Safety & Boundary Tests (S). |
| **M. Creator UX** | Missing world health panel, variable registry page, outline view, scene editor, and publish diff. | **CONFIRMED** | `docs/user-stories.md`. | `docs/user-stories.md`. | Prioritize creator outline and variable management UI. | Creator UX Roadmap Update (Y). |
| **N. Reader UX** | Discovery, onboarding, progressive reveal, diegetic locks, minimal journal, and ending catalog. | **CONFIRMED** | `docs/user-stories.md`. | `docs/user-stories.md`. | Add journal/recap and ending catalog hooks. | Reader UX Specifications. |
| **O. Knowledge Architecture** | Lack of distinct "fact" entity separating objective truth, Canon, character belief, and reader knowledge. | **CONFIRMED** | `db/migrations/001_initial_schema.sql`. | `docs/architecture.md`. | Define fact registry and knowledge visibility rules. | Knowledge Architecture Design Doc (W5). |
| **P. Database & State Architecture** | Monolithic JSONB snapshots, prose TEXT, UUID primary keys on timelines, immutability gaps. | **CONFIRMED** | `db/migrations/001_initial_schema.sql`. | `docs/repository-architecture.md`. | Address snapshot caching, timeline PK optimization, and immutability triggers. | Migration 001 Corrections (H6, H7, H8). |
| **Q. Security / Privacy / Trust** | Plaintext session IDs, case-sensitive emails, RESTRICT cascade deletes, UGC moderation missing. | **CONFIRMED** | `db/migrations/001_initial_schema.sql`, `src/modules/auth/`. | `docs/threat-model.md`. | Hash session tokens, add citext/lower index on email, establish UGC moderation. | Security & Privacy ADRs (X3, X5). |
| **R. Scalability & Economics** | High-concurrency database load, TOAST bloat on JSONB state updates, AI token cost management. | **CONFIRMED** | `docs/platform-readiness.md`. | `docs/platform-readiness.md`. | Add AI budget hooks, remove hot-path GIN indexes, plan partitioning. | Scalability & Capacity Plan (W10). |
| **S. Testing & Observability** | Missing property-based testing, golden scenarios, deterministic replay, and invariant test suite. | **CONFIRMED** | `tests/`. | `docs/testing-strategy.md`. | Expand testing strategy to include fast-check property tests and replay verification. | Testing Strategy Update (S). |
| **T. Long-Term Failure Analysis** | Risks of unqueryable JSON, state explosion, cost overruns, moderation traps, and documentation drift. | **CONFIRMED** | `PROJECT_STATE.md`. | All docs. | Enforce strict status truthfulness and state size caps. | Documentation Governance & Truthfulness Pass (H12). |
| **U. Over/Under-engineering** | Overengineered GIN indexes and job queues; underdesigned variable registry and state-reactive text. | **CONFIRMED** | `db/migrations/001_initial_schema.sql`, `src/`. | `docs/architecture.md`. | Remove unused GIN indexes; focus engineering effort on missing state foundations. | Corrective Finding H10. |
| **V. Required Design Corrections** | Service-spec model conflicts, transaction ownership ambiguity, route mismatches, draft entry points. | **CONFIRMED** | `docs/service-specifications.md`, `docs/runtime-design.md`. | `docs/service-specifications.md`. | Harmonize cross-document specifications. | Design Correction Pass (V1–V8). |
| **W. Recommended New Design Docs** | 10 new design documents needed covering narrative models, registries, privacy, AI provenance, etc. | **HUMAN DESIGN DECISION REQUIRED** | `docs/` | `docs/` | Author priority design documents before Phase D execution. | New Design Docs (W1–W10). |
| **X. Recommended ADRs** | 10 ADRs recommended for snapshots, state text, sessions, timeline branching, deletion, etc. | **HUMAN DESIGN DECISION REQUIRED** | `docs/decisions/` | `docs/decisions/` | Formally author and approve recommended ADRs. | ADR Creation (X1–X10). |
| **Y. Recommended Roadmap Changes** | Add lint/CI before C1, migration 001 corrections, narrative tasks, moderation baseline. | **CONFIRMED** | `ROADMAP.md`, `TASKS.md`. | `ROADMAP.md`, `TASKS.md`. | Update roadmap and task definitions to incorporate audit findings. | Roadmap & Task Alignment (Y). |
| **Z. Top 10 High Priorities** | H1-H10 critical foundational fixes (start crash, migration test, prose, registry, immutability, snapshot, auth, GIN). | **CONFIRMED** | Codebase and migration 001. | All source & schema. | Execute high-priority foundational corrections. | Task Execution Priorities (Z1–Z10). |
| **AA. Top 10 Value Opportunities** | State-reactive text, variable registry, Director, journal, replay, version change classes, outline, preview. | **HUMAN DESIGN DECISION REQUIRED** | Product vision. | `docs/vision.md`. | Prioritize high-value product opportunities in roadmap. | Roadmap Enhancement. |
| **AB. Previous Audit Delta** | Progress on C-2, H-1a, N-1, M-2; regression on H1/H3; persistent status doc overclaiming (H12). | **CONFIRMED** | Repository state vs. changelog. | `PROJECT_STATE.md`. | Maintain strict truthfulness in status reporting. | Documentation Audit Delta Review. |
| **AC. Final Gate** | Design Foundation Needs Corrections. | **CONFIRMED** | Overall audit evaluation. | `PROJECT_STATE.md`. | Hold design decision session before proceeding to Phase D. | Phase Transition Gate. |
| **AD. Implementing-Agent Guidance** | Rules 0 through 12 (claim verification, test integrity, env isolation, no test hooks, doc truthfulness, etc.). | **CONFIRMED** | Section AD of audit. | `governance/AI_AGENT_RULES.md`, `GEMINI.md`. | Incorporate red-team engineering guardrails into AI instructions. | Agent Rule Integration (AD). |

---

## 3. Unresolved Design Decisions Requiring Human Approval

1. **State-Reactive Prose Mechanism (H4)**: Deterministic conditional blocks and interpolation syntax.
2. **Typed Variable & Fact Registry (H5)**: Namespace, scoping, types, and condition evaluation AST.
3. **Snapshot Storage Optimization (H7)**: Monolithic JSONB blob vs. normalized published scene tables.
4. **Versioning Change Classes (H11)**: Reader migration rules for in-flight sessions upon publishing updates.
5. **Data Deletion & Anonymization Semantics (Q / H9)**: Hard delete cascades vs. soft-delete / PII anonymization.

---

## 4. Corrective Findings (Immediate Non-Architectural Action)

1. **H1 (Production Start Crash)**: Remove `--env-file .env` from `package.json` `start` script.
2. **H2 (Migration Test Isolation)**: Refactor `scripts/migrate.ts` to accept `connectionString` parameter.
3. **H3 (Unit Test Environment)**: Provide test database URL fallback in Vitest config.
4. **H10 (Hot-Path GIN Indexes)**: Drop 5 speculative GIN indexes from migration 001.
5. **H9 (Auth & Security Hardening)**: Hash session tokens, add case-insensitive index on `users.email`.
