# ADR-014: Phase F Design Contracts — Session Lifecycle, Snapshot Lookup, and Concurrency

- **Status**: Proposed (pending product-owner approval; no implementation authorized)
- **Date**: 2026-10-13
- **Decision Makers**: Sajacous Smith (product owner)
- **Consulted**: AI engineering agents (design-readiness review)

---

## 1. Context

Phase E (E0–E2c) is implemented and code-reviewed; PostgreSQL integration remains UNVERIFIED. Phase F (reader runtime: F1a, F1b, F1c, F2a) is design-gated. The product-owner review of the Phase F design-readiness assessment requires five contracts to be resolved and recorded before F1a begins:

1. Snapshot lookup semantics (`findLatestByWorldId`).
2. Session initialization: authentication, ownership, concurrent creates.
3. Session lifecycle transitions and terminal-state readability.
4. Optimistic-locking version-check contract for F2a.
5. Strategy for the outstanding PostgreSQL verification.

Choice submission and deterministic execution stay in Phase G. The expiry sweeper stays deferred. Idempotency-key *enforcement* stays deferred to Phase G (contract specified in ADR-013 D3).

---

## 2. D1 — Snapshot lookup: `findLatestByWorldId(worldId)`

**Decision**: Add `findLatestByWorldId(worldId: WorldId): Promise<CanonSnapshot | null>` to `CanonRepositoryPort` (scoped into F1b), implemented by `PostgresCanonRepository`.

- **Source of truth**: the highest `version_number` in `published_canon_snapshots` for the world (`ORDER BY version_number DESC LIMIT 1`). Never derived from `worlds.status` alone — status is a mutable draft/published marker; the snapshot table is authoritative.
- **No result**: returns `null` when the world has never been published. The F1b use case maps `null` → typed `NoPublishedSnapshotError` → HTTP 409 at the route layer (per the F1b spec: the world exists, but no published canon exists — 409, not 404).
- **`canon_schema_version` validation**: the repository validates `canon_data` against `CanonDataSchema` on read (same as the existing write path).
- **Corrupt snapshots**: if the latest snapshot fails schema validation, throw a typed `CorruptCanonSnapshotError` → HTTP 500 (server-side invariant violation). Rationale: the E2c trigger makes snapshots immutable, so a corrupt latest snapshot means deep data corruption or a schema version newer than this code understands. **Never silently fall back to an older version** — serving a reader a silently-downgraded canon would be worse than failing loudly.

---

## 3. D2 — Session initialization: auth, ownership, concurrency

**Decision**:

- **Authentication required**: `POST /worlds/:id/sessions` uses the existing `authenticate` + `requireReader` middleware (per the F1c spec: any authenticated reader; creators acting as readers are out of scope for this slice — `requireReader` gates creation as specified).
- **Owner derivation**: the session's `reader_id` is derived **exclusively** from `request.user.userId` (the authenticated session). The client never supplies the owner — no owner-spoofing surface.
- **Simultaneous initialization**: all concurrent creates succeed as independent sessions (ADR-013 D2: multiple sessions per reader per world; PK defaults to `gen_random_uuid()`; no uniqueness constraint beyond the PK). No idempotency-key enforcement in this slice (deferred to Phase G per ADR-013 D3) — a retried request may create a duplicate session; accepted and documented.

---

## 4. D3 — Session lifecycle

**Decision**: the `ReaderSession` entity (F1a) enforces:

- **Legal transitions**: `active → completed`, `active → abandoned`. `active → active` is not a transition (no-op rejected).
- **Terminal states are absorbing**: `completed` and `abandoned` admit no outgoing transitions. Any attempt throws a typed domain error — terminal sessions must not silently return to `active`.
- **`completed`** only via reaching a terminal ending (`is_ending` scene); **`abandoned`** only via explicit reader close.
- **Terminal sessions remain readable**: `GET /sessions/:id` works for `completed`/`abandoned` sessions (history stays viewable); they cannot be transitioned or mutated.

---

## 5. D4 — Optimistic locking contract (F2a)

**Decision**: every state-changing persistence operation takes an `expectedVersion`:

1. Inside **one** transaction: `SELECT ... FOR UPDATE` the session row.
2. Compare the row's `version` to `expectedVersion`. **Mismatch → throw typed `SessionVersionConflictError` → HTTP 409, and ROLLBACK** — no state diff applied, no timeline row inserted, no version bump. Zero partial writes.
3. On match: apply the state diff to `state_variables`, INSERT the timeline row (next `sequence_number`, gapless via the existing unique constraint), UPDATE the session (`version + 1`, `updated_at`), COMMIT.
4. The 409 response includes the current version so the client can re-synchronize (per `docs/runtime-design.md` §3).

This contract establishes the *mechanism* in F2a; the choice-application *resolution logic* that uses it lands in Phase G.

---

## 6. D5 — PostgreSQL verification strategy

**Decision**: track the outstanding database checks as a **parallel verification task**; do not block Phase F on them.

Rationale:

- Docker is unavailable in this environment, so blocking would stall Phase F indefinitely with no path forward here.
- F1a–F1c are fully unit-verifiable with fakes; F2a's own integration tests will follow the established UNVERIFIED-until-Docker convention (same as E2a/E2b/E2c).
- The outstanding checks (fresh 001–005 migration run, P0001 trigger behavior, concurrent publishing, JSONB round-trip) are independent of Phase F code and can execute in CI whenever Docker is available.

The outstanding checks are listed as a parallel verification track in `PROJECT_STATE.md`. They must pass before any production deployment, but they do not gate Phase F implementation or review.

---

## 7. Ancillary resolutions (from the design-readiness review)

- **Route prefix**: F1c uses unprefixed routes (`POST /worlds/:id/sessions`), following the implemented E2b convention. `docs/runtime-design.md`'s `/api/v1` prefix is aspirational relative to the implemented API and does not govern Phase F routes.
- **Timeline immutability**: `reader_timelines` stays append-only by code convention in this slice (no trigger) — the F2a acceptance criterion "no code path issues UPDATE/DELETE against `reader_timelines`" is enforced by port surface (no mutating methods) plus review. A trigger remains available as a future hardening option.
- **409 for unpublished worlds** (F1b/F1c) is deliberate: the world exists (no 404), but the precondition "has a published snapshot" fails — 409 Conflict, consistent with the version-conflict 409 in D4.

---

## 8. Consequences

- F1b gains a small, well-bounded addition: `findLatestByWorldId` on the canon port + Postgres implementation + tests.
- F1a's entity carries the transition table and the absorbing-terminal invariant with unit tests.
- F2a's persistence contract is fully specified before code begins; its integration tests remain UNVERIFIED until Docker/CI.
- No Phase G scope enters Phase F; no implementation is authorized by this ADR.

---

## 9. Batch 2 Design: F1c Routes + F2a Atomic Persistence (Proposed 2026-10-13)

F1c and F2a are designed together because F1c's production wiring needs F2a's
`PostgresSessionRepository`, and both must share one consistent authorization
and domain-delegation story. No implementation is authorized by this section.

### 9.1 F1c — session HTTP routes

New module `src/modules/session/http/session.routes.ts`, registered in `app.ts`
following the `worldRoutes` pattern:

```ts
export interface SessionRouteDeps {
  sessionRepository: SessionRepositoryPort;
  worldRepository: WorldRepositoryPort;
  canonRepository: CanonRepositoryPort;
  sessionVerifier: SessionVerifier;
}
```

`AppDeps` gains optional `sessionRepository` (Postgres default wired in
`buildApp`; fakes injectable for route tests).

**`POST /worlds/:id/sessions`** (path per the approved F1c spec; the
"POST /sessions" phrasing in review discussion was shorthand — `worldId`
belongs in the path, matching the `POST /worlds/:id/publish` convention):

- Pre-handlers: `[authenticate, requireReader]` (existing middleware; creators
  get 403, unauthenticated get 401).
- Zod UUID param validation → 400 on malformed ids.
- `readerId` taken exclusively from `request.user.userId` — never from the
  body or params.
- Delegates to `StartReaderSessionUseCase({ worldId, readerId })`.
- **201** → `{ sessionId, snapshotId, versionNumber, currentSceneId, status }`.
- Error mapping (all via the central handler, no new envelope work):
  unknown world → 404 (`WorldNotFoundError`), no published snapshot → 409
  (`NoPublishedSnapshotError`).

**`GET /sessions/:id`**:

- Pre-handlers: `[authenticate]` (ownership check is the real gate).
- Delegates to a new thin `GetReaderSessionUseCase({ sessionId, readerId })`
  in the session application layer: `findById` → null **or**
  `!session.getReaderId().equals(readerId)` → `SessionNotFoundError` (404).
  The 404-not-403 ownership check lives in exactly one place (the use case);
  the route stays thin and no authorization logic is duplicated.
- **200** → `{ sessionId, readerId, worldId, snapshotId, currentSceneId,
  stateVariables, version, status, createdAt, updatedAt }` (terminal sessions
  included — readable per D3).

**F1b touch-up (additive, within Batch 2)**: `StartReaderSessionResult` gains
`snapshot: CanonSnapshot` so F1c can return `versionNumber` without a second
query. Backward compatible; does not alter F1b's approved contract.

### 9.2 F2a — atomic session persistence

New `src/modules/session/infrastructure/persistence/postgres-session.repository.ts`
implementing `SessionRepositoryPort` (`findById`, `findByReaderId` with a
`reader_id` predicate on every query, `save` as upsert with optional tx —
following `postgres-world.repository.ts`), plus:

```ts
applyTransition(args: {
  sessionId: SessionId;
  expectedVersion: number;
  toSceneId: SceneId;
  stateDiff: SessionState;
  choiceId: ChoiceId;   // required by reader_timelines; supplied by Phase G's resolver
}, tx?: pkg.PoolClient): Promise<ReaderSession>
```

One transaction (joins the passed `tx`, or manages its own via the
`withTransaction` helper):

1. `SELECT ... FOR UPDATE` the session row → not found → `SessionNotFoundError`
   (404), rollback.
2. Rehydrate the `ReaderSession` entity from the row.
3. Compare row `version` to `expectedVersion` — mismatch → throw
   `SessionVersionConflictError` → **409, ROLLBACK, zero partial writes**.
4. Capture `fromSceneId`, then call `entity.applyTransition(toSceneId, stateDiff)`
   — the domain entity enforces active-only and bumps the version. The
   repository never bypasses the entity and never duplicates transition logic.
5. `UPDATE reader_sessions` (current_scene_id, state_variables, version + 1,
   updated_at) + `INSERT INTO reader_timelines` (next `sequence_number`
   computed in-transaction; the locked session row serializes writers, the
   `UNIQUE(session_id, sequence_number)` constraint is the backstop).
6. COMMIT; return the updated entity.

**409 contract** (ADR-014 D4): new `SessionVersionConflictError extends
SessionError` (statusCode 409) carrying `report = { currentVersion }` — the
existing 4xx `report` envelope (E2b precedent) surfaces it, so the client can
re-synchronize. No handler changes needed.

### 9.3 Integration fit (no bypasses, no duplication)

- Routes → use cases → (entity + repository). Routes never touch SQL.
- Ownership checked once (`GetReaderSessionUseCase`); transition rules once
  (`ReaderSession.applyTransition`); the F2a repository contributes SQL +
  transactions only.
- `requireReader`/`authenticate` at the route layer; repository-level
  `reader_id` predicates as defense in depth (F2a completeness gate).

### 9.4 Tests

- **F1c route tests** (`buildApp` + inject, fakes): 201 shape (incl.
  `versionNumber`), 401, 403 (creator role), 404-not-403 cross-reader GET,
  409 no published snapshot, 400 malformed id, terminal session readable.
- **F2a integration** (Testcontainers, UNVERIFIED until Docker/CI): atomic
  commit, induced-failure rollback (both tables), concurrent conflicting
  writes → one 409, gapless `sequence_number`. **Unit**: conflict-error
  mapping (409 + `report.currentVersion`).
- No Phase G choice-execution code; no idempotency enforcement.

---

## 10. Implementation-Gate Confirmations (verified 2026-10-13 against code/schema)

These confirmations resolve the review's four contract checks. F1c/F2a remain
unauthorized until product-owner approval of this finalized design.

### 10.1 Error mapping (verified against `src/app.ts` central handler)

The handler maps `error.statusCode` (400–599) to the response status; 4xx
bodies are `{ error, statusCode }` plus `report` when the error carries one;
5xx bodies are `{ error: 'Internal Server Error', statusCode }` with no
`report`. ZodErrors short-circuit to 400 with `issues`. Verified mapping:

| Error | HTTP | Body |
|---|---|---|
| ZodError (malformed UUID param) | 400 | `{ error: 'Validation failed', statusCode: 400, issues }` |
| `WorldNotFoundError` | 404 | `{ error: 'World not found', statusCode: 404 }` |
| `NoPublishedSnapshotError` | 409 | `{ error: 'World has no published snapshot', statusCode: 409 }` |
| `SessionNotFoundError` (missing or not-owned) | 404 | `{ error: 'Reader session not found', statusCode: 404 }` |
| `SessionVersionConflictError` | 409 | `{ error, statusCode: 409, report: { currentVersion } }` |
| `CorruptCanonSnapshotError` | 500 | `{ error: 'Internal Server Error', statusCode: 500 }` (report excluded on 5xx) |
| `IllegalSessionTransitionError` | 400 | `{ error, statusCode: 400 }` |

No handler changes are needed: every F1c/F2a error already maps correctly,
and the 409 `report` reuses the E2b `report` envelope precedent.

### 10.2 F1b result contract (consumers inspected)

`StartReaderSessionResult` is consumed only by its own unit test
(destructuring `{ session }`). Adding `snapshot: CanonSnapshot` is purely
additive — no existing consumer breaks. The F1c route returns only the five
public fields (`sessionId`, `snapshotId`, `versionNumber`, `currentSceneId`,
`status`); `canon_data` is never serialized.

### 10.3 Transaction contract (vs `withTransaction` in `src/shared/database/db.ts`)

- **Same client**: `SELECT ... FOR UPDATE`, version comparison, session
  `UPDATE`, and timeline `INSERT` all execute on one `pkg.PoolClient` — the
  type matches the existing `WorldRepositoryPort`/`CanonRepositoryPort`
  convention (`tx?: pkg.PoolClient`).
- **Ownership**: if the caller supplies `tx`, the repository issues statements
  only — it never `BEGIN`s, `COMMIT`s, or `ROLLBACK`s; the caller owns the
  boundaries. If no `tx` is supplied, the repository wraps the work in the
  existing `withTransaction` helper (which owns BEGIN/COMMIT/ROLLBACK and
  preserves the original error). No parallel transaction abstraction is
  introduced.
- **Atomicity**: version mismatch, entity validation failure, or timeline
  insert failure all abort before/without partial writes — the single
  transaction rolls back the session update together with the timeline insert.

### 10.4 Sequence semantics ("gapless" clarified)

"Gapless" means **no missing `sequence_number` values among committed
timeline entries per session** — not PostgreSQL `SEQUENCE`/`nextval()`
semantics (which burn values on rollback and would create gaps).

Allocation: `SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM
reader_timelines WHERE session_id = $1`, computed **inside the same
transaction while holding the session row's `FOR UPDATE` lock**. The lock
serializes concurrent transitions on the same session, so two writers cannot
compute the same next value. A failed transaction rolls back its timeline
`INSERT` along with everything else, leaving no gaps among committed rows.
The existing `UNIQUE(session_id, sequence_number)` constraint is the
backstop: any race that slipped through fails the insert and rolls back the
whole transaction.

### 10.5 Minimum test gate (coverage confirmed)

| Test group | Coverage | Environment |
|---|---|---|
| F1c routes | 201 shape (incl. `versionNumber`), 401, 403, 400 malformed id, 404 unknown world, 409 no snapshot | Unit (fakes) |
| F1c ownership | Own session readable; missing and another reader's session both 404; terminal session readable | Unit (fakes) |
| F2a conflict | Stale version → 409 with `currentVersion`, no partial writes | Unit (error mapping) + integration (persistence) |
| F2a atomicity | Success updates session + appends timeline together; forced timeline failure rolls back both | Integration (UNVERIFIED) |
| F2a concurrency | Same expected version concurrently → at most one succeeds; stale gets 409 | Integration (UNVERIFIED) |
| Sequence integrity | Committed entries carry the expected next sequence; failed transitions persist no timeline row | Integration (UNVERIFIED) |

No database test result will be claimed as passing until executed in a
suitable environment; Docker/Testcontainers checks stay explicitly
UNVERIFIED.

