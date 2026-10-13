# ADR-013: Phase E/F Gap Closure — Publishing Foundation Before Reader Runtime

- **Status**: Proposed (pending product-owner approval of the planning documents)
- **Date**: 2026-10-13
- **Decision Makers**: Sajacous Smith (product owner)
- **Consulted**: AI engineering agents (governance review)

---

## 1. Context and Problem Statement

The Phase F planning audit (2026-10-13) found that Phase E was marked complete but two of its tasks were never implemented:

- **E1** (publishing graph validation) — no code exists.
- **E2** (immutable Published Canon snapshot generation) — no code exists.

F1's prerequisites are "Task C3, Task E2," and F1 binds sessions to `canon_version_id`. Per AGENTS.md prerequisite rules, Phase F cannot begin until E2 exists. The `src/modules/session/` directories are empty scaffolding.

The schema itself is ready: migration 001 already defines `published_canon_snapshots`, `reader_sessions`, and `reader_timelines` with sound constraints (composite FK from sessions to snapshots, append-only timelines, optimistic-locking version column). What is missing is purely application code — plus two schema gaps the audit surfaced (see §3).

## 2. Decision Drivers

- Prerequisite integrity: reader sessions must bind to an actually-immutable canon, or the canon-vs-timeline isolation guarantee is fiction.
- `docs/runtime-design.md` already specifies the 9-stage pipeline, ACID state+timeline binding, `SELECT ... FOR UPDATE` + version integers, and idempotency keys — the design is not greenfield.
- `docs/detailed-design.md:63` specifies terminal endings as nodes with `ending: true`, but no such flag exists in code — the defined schema was never implemented.
- No document anywhere designates the start scene — graph traversal has no defined entry point.

## 3. Schema Gaps Found (resolved, not invented)

1. **Terminal ending marker**: `detailed-design.md` requires `ending: true` nodes. Resolution: add `is_ending BOOLEAN NOT NULL DEFAULT FALSE` to `scenes` via migration 004. This implements the defined design; it does not invent a new one.
2. **Start scene designation**: undefined everywhere. Resolution: add `start_scene_id UUID REFERENCES scenes(scene_id)` to `worlds` via migration 004 (nullable until set; publishing requires it). One start per world, referentially intact. Chosen over a per-scene boolean because a world has exactly one entry point and the FK prevents dangling references.

## 4. Decisions (product-owner approved 2026-10-13)

### D1 — Canon immutability: trigger + application safeguards + tests
`published_canon_snapshots` rows are immutable after insert. Enforcement is two-layer:
- Application: no repository method issues UPDATE/DELETE against snapshots; publish only INSERTs.
- Database: migration 004 adds a trigger rejecting UPDATE and DELETE on `published_canon_snapshots`.
- Refinement: the trigger must not block legitimate lifecycle operations. FK references to snapshots use `ON DELETE RESTRICT` (already the case); retention and account-deletion semantics are explicitly out of scope for this slice and must be designed before any purge tooling is built. Migration operations themselves (schema changes) are unaffected — the trigger guards row mutation, not DDL.
- Tests: unit/integration tests asserting application paths cannot mutate canon, plus a direct-SQL test asserting the trigger rejects UPDATE/DELETE.

### D2 — Multiple sessions per reader per world
Each session is an independent playthrough with its own state and timeline. No one-session constraint. Authorization is enforced per session operation (reader owns the session). Lifecycle: `active` → `completed` (reader reaches a terminal ending) or `abandoned` (explicit close by the reader; expiry-based abandonment deferred — no background sweeper in this slice).

### D3 — Idempotency: contract specified now, implemented with retryable commands
The `X-Idempotency-Key` contract is specified here; enforcement lands with Phase G choice submission (the first retryable state-changing reader command). F2 still establishes transaction boundaries and concurrency behavior (`SELECT ... FOR UPDATE`, version check → 409 on mismatch).
- Contract: client sends `X-Idempotency-Key` (UUID v4) on state-changing requests. Server stores key → response for 24h. Same key + same payload returns the cached response without re-executing. Same key + different payload returns `409 Conflict` (never silently executes twice).

## 5. Validation Semantics (resolved per FR-05's faithful reading)

FR-05 requires the check to "detect orphaned/unreachable scenes" and "reject structurally invalid publications." Resolved:
- **Blockers** (publishing rejected): no start scene set; dangling choice target (references nonexistent scene); no terminal ending reachable from the start scene; world has no scenes.
- **Warnings** (reported, not blocking): well-formed but unreachable scenes. Rationale: unreachable content cannot corrupt a reader's experience (traversal starts at the designated start scene); blocking on it would frustrate creators with draft side-content. Warnings are returned in the validation report.
- **Condition/mutation references**: conditions and mutations are currently opaque JSON (`ConditionSchema = jsonObjectSchema`; formal grammar deferred to G1 per code comment and requirements). E1b validates structural references only (choice → scene target existence). Semantic condition-reference validation arrives with the G1 grammar. This is a documented limitation, not an invented schema.

## 6. Scope and Task Order (approved)

E0 (migration 004 + entity fields) → E1a (reachability) → E1b (reference validation) → E2a (publish use case + repo) → E2b (publish route) → E2c (immutability trigger + tests) → F1a/F1b/F1c (session model, init, routes) → F2a (atomic persistence). Full task specs in TASKS.md.

## 7. Change Classification

**Level 3** (Architecture / Data): new migration, new tables already exist but new constraints/trigger, new module code. No Level 4 — authentication/authorization boundaries are unchanged (session ownership enforced within existing RBAC). System Completeness Gate evaluation for the slice is recorded in TASKS.md task E2c/F2a notes.
