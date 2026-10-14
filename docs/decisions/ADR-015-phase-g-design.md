# ADR-015: Phase G Design — Deterministic Choice Submission & Narrative Execution

- **Status**: Accepted (product-owner approved 2026-10-13; implementation authorized and completed 2026-10-13, awaiting implementation review)
- **Date**: 2026-10-13
- **Decision Makers**: Sajacous Smith (product owner)
- **Consulted**: AI engineering agents (design gate)

---

## 1. Context

Phase F (F1a–F2a) is implemented, source-reviewed, and pushed (`831b2f6`); PostgreSQL integration is verified 31/31. Phase G ("Deterministic Narrative Execution") is design-gated: TASKS.md defines G1 (pure condition evaluation engine) and G2 (state transition & choice resolution use case), and ROADMAP.md gates G1 on 100% unit-test coverage of the pure functions.

Binding requirements:

- **FR-04**: choices carry deterministic conditional requirements (comparisons, boolean AND/OR, inventory/state checks, relationship thresholds) and state-mutation effects.
- **FR-08**: readers are presented with available choices filtered by deterministic evaluation of reader state.
- **FR-09**: selecting a choice deterministically updates persistent reader state and transitions to the next scene.
- **FR-05 / ADR-013 §5 (Option A)**: condition/mutation references are currently opaque JSON. **G1 must define semantic validation and its failure behavior** (publish-time and runtime); the runtime must handle invalid references safely, never silently producing incorrect outcomes.
- **NFR-01**: evaluation + transition under 100ms (single-user baseline). **NFR-03**: state changes durably persisted immediately on choice selection. **SEC-03**: input validation on choice submissions.
- **ADR-013 D3**: `X-Idempotency-Key` contract specified; **enforcement lands with Phase G** (first retryable state-changing reader command).
- **ADR-014 D3/D4**: absorbing terminal lifecycle; optimistic-locking 409 contract with `currentVersion` in the response (F2a mechanism, reused by G2).

Current state of the pieces G2 will compose:

- `Choice.conditions: ConditionPayload` / `Choice.mutations: MutationPayload` are **opaque JSON** (`ConditionSchema = MutationSchema = z.record(jsonSchema)` in `world-schemas.ts`). No runtime reads them.
- `ReaderSession.applyTransition(toSceneId, stateDiff)` merges a diff, bumps `version`, sets `updatedAt`; rejects when terminal.
- `PostgresSessionRepository.applyTransition` executes one transaction: `SELECT … FOR UPDATE` → version check (mismatch → 409 rollback) → entity transition → timeline insert (gapless `MAX+1` under row lock) → commit.
- Canon snapshots are immutable (migration 005 trigger); the session is pinned to a `snapshotId`.

### Phase F audit (no undocumented gaps)

F1a (entity/port), F1b (init use case + `findLatestByWorldId`), F1c (`POST /worlds/:id/sessions`, `GET /sessions/:id`), F2a (atomic persistence) are all implemented per their TASKS.md specs. One flagged deferred item, not a gap: `ReaderSession.abandon()` exists on the entity but **no HTTP route exposes it** — ADR-014 D3's "abandoned only via explicit reader close" has no transport. Decided in §9.4 as a separate Phase F follow-up (`POST /sessions/:id/abandon`), not G2 scope.

---

## 2. D1 — Condition / mutation grammar contract (G1)

**Decision (product-owner approved 2026-10-13)**: replace the opaque JSON schemas with a formal, versioned grammar. Pure functions, zero side effects, no randomness, no clock reads — same input always yields same output (determinism requirement).

State model: `SessionState = Record<string, unknown>` (JSON values; F1a).

```ts
// Conditions: predicates over the state map.
type Condition =
  | { op: 'and'; conditions: Condition[] }   // non-empty; see below
  | { op: 'or'; conditions: Condition[] }    // non-empty; see below
  | { op: 'not'; condition: Condition }
  | { op: 'eq' | 'ne'; var: string; value: JsonValue }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; var: string; value: number }
  | { op: 'has'; var: string }                       // key present (inventory/state check)
  | { op: 'in'; var: string; values: JsonValue[] };   // membership check

// Mutations: applied in array order; each is deterministic.
type Mutation =
  | { op: 'set'; var: string; value: JsonValue }
  | { op: 'inc'; var: string; by: number }            // target must exist and be numeric
  | { op: 'dec'; var: string; by: number }            // target must exist and be numeric
  | { op: 'toggle'; var: string }                     // boolean flip; missing → true
  | { op: 'unset'; var: string };                     // removes the key if present
```

- **Unconditional choices**: the `conditions` field is **absent** (`undefined`) → always available. An empty object `{}` is **rejected at publish validation** (malformed: neither absent nor a valid `Condition`). There is exactly one serialized representation of "no condition."
- **Absent `mutations` ≡ empty list.** A choice without a `mutations` field is valid everywhere a choice with `mutations: []` is valid: publish validation accepts it, legacy execution treats it as no mutations, and the response carries `appliedMutations: []`. (`mutations: null` or any non-array shape is malformed → publish blocker / marker-dependent parse failure at runtime.)
- `and.conditions` / `or.conditions` are **non-empty arrays** (publish-time blocker if empty). Rationale: an unconditional choice already has a representation (absent conditions); empty boolean operators would be a second, ambiguous one.
- `var` is a non-empty string, max 128 chars, flat key (no dots, no paths). Nested state paths are out of scope for MVP — this keeps evaluation total and auditable. The values `__proto__`, `constructor`, and `prototype` are **rejected** (C3): ordinary JavaScript property assignment on these keys causes prototype pollution instead of own-property mutation, so they can never be safely round-tripped through a plain object. Rejected at publish validation (blocker) and at runtime parse (marker-dependent policy, like any malformed shape). A unit test must assert rejection of all three.
- **Operand types** (enforced by Zod when a choice payload is parsed — at publish time for every choice, and at the execution boundary for the choices being evaluated/applied; **not** by revalidating the whole stored snapshot on read — the transport schema stays loose per §10, so legacy snapshots always read):
  - `and`/`or`: `conditions` is a non-empty array of `Condition`.
  - `not`: `condition` is a single `Condition`.
  - `eq`/`ne`: `value` is any JSON literal, array, or object. Comparison uses **deep equality** (object key order insignificant).
  - `gt`/`gte`/`lt`/`lte`: `value` is a finite number; the state's value must be a finite number.
  - `has`: no `value` operand. **True iff the key exists in the state map** — including when the stored value is `null`. This is the inventory/state check ("does the reader have the sword?").
  - `in`: `values` is a non-empty array of **any JSON values** (`JsonValue[]`), matched by **deep equality** — the same equality the `eq` operator uses. This is the membership check ("is alignment one of [good, neutral]?"). `has` and `in` never overlap: presence vs. membership.
- **Missing-value behavior**: a missing `var` in any condition predicate → **false** (never true-by-default, never throws). Mutation missing-var behavior is per-operation (see table in D1a) — there is no blanket default.
- **Nesting limits** (publish-time validation): max condition depth 10, max total condition nodes 100 per choice, max 50 mutations per choice. Prevents pathological payloads and bounds NFR-01 evaluation cost.
- **Numeric rules**: all numbers must be finite (`Number.isFinite`). Non-finite literals are rejected at publish validation; non-finite results at runtime are rejected (see D1a). `inc`/`dec` accept a negative finite `by` (documented: `inc` by `-3` ≡ `dec` by `3`); `by: 0` is a legal no-op mutation.
- Grammar version is pinned alongside the canon: a `condition_grammar_version: 1` marker rides in the v1 canon schema so future grammars can be distinguished without silent reinterpretation.

**Alternatives considered**: (a) string-expression DSL (`"gold >= 10 && has('sword')"` ) — rejected: requires a parser, worse error messages, injection-adjacent surface; (b) JSONLogic-compatible subset — rejected: larger surface than FR-04 needs, external spec dependency. The tagged-object grammar is self-describing, Zod-validatable, and trivially serializable.

### D1a — Semantic validation and failure behavior (TASKS.md G1 acceptance criterion)

- **Publish time** (extends E1b): walk every choice's conditions/mutations. Unknown `op`, malformed shape (e.g. `gt` with non-number `value`), non-string/empty/overlong `var`, nesting beyond the §2 limits, or non-finite numeric literals → **publishing blocker** (422, same taxonomy as FR-05). Variable *names* are NOT validated at publish time — the state map is runtime data; a `var` that never exists is legal (conditions on it evaluate false per §2; mutations on it are rejected per below).
- **Runtime conditions**: evaluation is total — it never throws on data shape:
  - Missing `var` → **false**. Type mismatch (e.g. `gt` against a string) → **false**.
  - Unknown `op` in a v1-marked snapshot → **500** (server-side invariant violation). Rationale: publish validation rejects unknown ops, so one at runtime means canon/code drift or corruption — same fail-loud precedent as corrupt canon snapshots (ADR-014 D1). **Never silently treat as false** — that would hide corruption behind wrong narrative outcomes. The 500 response is generic; the internal diagnostic (choice id, op) is logged server-side only.
  - **Legacy payloads** (snapshot without the grammar marker — see §10): conditions that do not parse as v1 grammar **fail closed**: the choice is treated as unavailable (422 `ChoiceNotAvailableError` if selected). Exception: the empty object `{}` is grandfathered as unconditional (it was the documented pre-G1 semantic). Any other unparsable shape is not silently reinterpreted. Rationale: pre-G1 canon was never validated; failing closed denies an unevaluatable choice rather than guessing a narrative outcome. A marker-present snapshot with unparsable conditions is the 500 case above (its publish validation should have caught it).
- **Runtime mutations** (product-owner decision 2026-10-13, refined in review): **reject invalid operations, never coerce, never silent no-op.** Missing-variable behavior is explicit per operation:

  | op | target var missing | target var present but wrong type | non-finite `by` | non-finite **result** |
  |---|---|---|---|---|
  | `set` | creates the key | replaces (any JSON value) | n/a | n/a (see note) |
  | `inc` / `dec` | **422** | **422** (non-numeric) | **parse failure** (marker-dependent: 500 / 422-fail-closed) | **422** |
  | `toggle` | sets `true` | **422** (non-boolean) | n/a | n/a |
  | `unset` | success, reported `removed: false` | removes the key, reported `removed: true` | n/a | n/a |

  Note: a non-finite `by` (or a non-finite literal anywhere in a mutation, e.g. a non-finite `set` value) violates the grammar itself — it fails at **Phase 1 (parse)**, never reaching applicability. A finite `by` whose arithmetic overflows to a non-finite result (e.g. `1e308 + 1e308`) is a **Phase 2 (applicability)** failure → 422 `MutationApplicationError`.

  Any **422 applicability** case → typed `MutationApplicationError` → complete rollback, **nothing written** (no state change, no timeline row, no version bump, no idempotency record). Parse failures carry their own error types per the marker-dependent policy (`CanonInvariantError` → 500 for marked snapshots; `LegacyPayloadRejectedError` → 422 fail-closed for legacy) — see the two-phase boundary below and B24.
  - Rationale: a mutation that cannot apply is a content/state bug the creator must fix; silently coercing or skipping would produce narrative state the author never designed. Conditions may safely evaluate false on bad data; mutations must not silently become no-ops.
- **Two-phase parsing boundary**: shape validation and applicability are distinct phases and must never be conflated.
  - *Phase 1 — parse*: the payload must satisfy the v1 grammar (Zod discriminated union on `op`). An unknown operator or malformed shape fails here → **500** for marked snapshots (publish validation should have caught it), **422 fail-closed** for legacy snapshots (B9). A parse failure never reaches applicability checks.
  - *Phase 2 — applicability*: the payload parsed cleanly but cannot apply to the current state (D1a table: missing/non-numeric `inc` target, etc.) → **422** `MutationApplicationError`.
  - An unknown operator can therefore never be misclassified as an ordinary precondition failure: precondition checks only run on successfully parsed mutations.
- **Legacy mutations** (snapshot without the grammar marker): a mutation list that does not parse as v1 grammar → the choice cannot be applied safely → **422** `LegacyPayloadRejectedError` if selected (fail closed; nothing written). The `{}`-as-unconditional bridge applies to conditions only.
- Mutation validation happens **in memory while holding the session row lock, after the authoritative version check, before any persistent writes** (see D3). The 422 path rolls back with zero writes. (This supersedes the earlier "before the transaction opens" wording: evaluating against a stale pre-lock state could mask a version conflict — see D3.)

### D1b — Mutation-application → persistence interface (B8)

F2a's `ReaderSession.applyTransition(toSceneId, stateDiff)` shallow-merges a diff (`{...state, ...diff}`) — a JSON diff cannot represent key deletion, so G1's `unset` cannot travel through that contract. The interface is therefore:

1. **Pure applier** (G1, no I/O): `applyMutations(state: SessionState, mutations: Mutation[]) → { state: SessionState; applied: AppliedMutation[] }`. It works on a **fresh deep copy** of the input — never mutating the caller's object — validates and applies each mutation to the working copy in order, and **returns nothing until all mutations succeed**: on the first invalid mutation it throws `MutationApplicationError` with the input object untouched, so earlier mutations in the list cannot leak through a partially modified object. On success it returns the complete resulting state (not a diff) plus the ordered applied-mutation records. Deterministic.
2. **Entity** (new G2 method; F2a's `applyTransition` is unchanged): `applyChoiceResult(toSceneId: SceneId, newState: SessionState, opts: { isEndingTarget: boolean })`. Validates the session is active, validates `newState` against `SessionStateSchema`, then **replaces** `stateVariables` wholesale (defensive copy), sets the scene, increments `version` exactly once, updates `updatedAt`, and sets `status = isEndingTarget ? 'completed' : 'active'`. Completion is **derived**, not flagged: there is no `complete` parameter to mismatch, so the entity structurally cannot express "ending target but still active" or "completed without an ending target." If `newState` fails `SessionStateSchema` validation — which means the applier itself produced an invalid state, a server bug, not a canon or client problem — the entity throws `StateInvariantError` → **500** (B37). This check runs in memory at D3 step 14, before any persistent write. One atomic domain operation; F2a's shallow-merge invariants and tests are untouched.
3. **Timeline**: for G2 transitions, the `state_diff` column stores `{ "kind": "choice-execution-v1", "applied": [...] }` — a discriminated envelope around the ordered applied-mutation list. It is the honest account of what changed — including `unset` with `removed: false` — and avoids overloading JSON `null` to mean deletion. F2a's existing rows remain bare object diffs (no `kind` key); every reader of `state_diff` must handle both shapes (discriminate on the presence of `kind`), and this is covered by tests. F2a's own write path and tests are unchanged.

---

## 3. D2 — Choice-submission contract

**Decision (product-owner approved 2026-10-13)**:

- **Route**: `POST /sessions/:id/choices` — unprefixed, following the F1c convention (ADR-014 §7: `/api/v1` is aspirational).
- **Auth**: `authenticate` + reader ownership; session's `reader_id` must equal `request.user.userId`, else **404-not-403** (never reveal other readers' sessions).
- **Request body** (Zod, strict):
  ```ts
  { choiceId: UUIDv4, expectedVersion: positiveInteger }
  ```
- **Header**: `X-Idempotency-Key: UUIDv4` — **required** on this route (per ADR-013 D3; first enforced route).
- **Response 200** (exact schemas; product-owner decision 2026-10-13):
  ```ts
  {
    sessionId: UUID,
    version: number,                       // committed version AFTER this transition
    currentSceneId: UUID,                  // scene AFTER this transition
    status: 'active' | 'completed',
    appliedMutations: Array<
      | { op: 'set' | 'inc' | 'dec' | 'toggle'; var: string; value: JsonValue }
      | { op: 'unset'; var: string; removed: boolean }
    >,   // discriminated: `removed` distinguishes an actual deletion from a
         // no-op on an already-absent key (never conflated with null)
    availableChoices: Array<{              // FR-08: eligible in the NEWLY committed state
      choiceId: UUID,
      text: string,                        // choice button label
      sortOrder: number
    }>
  }
  ```
  - `appliedMutations` reflects exactly what was committed, in application order. (Invalid mutations never reach here — they fail at step 13 per D1a's marker-dependent policy.)
  - `availableChoices` exposes only `choiceId`/`text`/`sortOrder`: enough to render decision buttons. Conditions, mutations, and `targetSceneId` are **never** exposed (narrative spoilers and gating logic stay server-side).
  - `stateVariables` are intentionally **not** returned (minimize payload; `GET /sessions/:id` remains the inspection path per US-R05).
  - **Idempotent retry replays the stored response data** — never recomputed from later session state.
  - **Replay validation** (B38): every replay path (D3 steps 3 and 8, D3a recovery) validates the stored JSONB against the response schema above **before** returning it. A stored response that fails validation is never served: the request fails with a generic **500** via `StoredResponseCorruptError`, logged server-side with the key id (never exposed). Rationale: the record was written by our own step 16, so corruption implies storage tampering or a disk fault — fail loud rather than serve malformed data to the client.

---

## 4. D3 — Deterministic state-transition rules (G2)

**Decision (product-owner corrected order, 2026-10-13; race-hardened in review)**: `SubmitChoiceUseCase.execute` runs these steps in fixed order. Two corrections from review are incorporated: (a) the idempotency key is re-checked *inside* the transaction after the row lock — otherwise a loser that waited on the lock would 409 on the version check instead of replaying the winner's response; (b) the authoritative version check precedes state-dependent evaluation — otherwise a stale client could receive 422 (condition false / mutation invalid against stale state) instead of the specified 409.

**Pre-transaction** (no writes):

1. Authenticate; load session by id; null or wrong owner → `SessionNotFoundError` → 404 (ownership established before anything else).
2. Validate `X-Idempotency-Key` format (UUID v4; missing/malformed → 400) and compute the request fingerprint: `sha256` over the canonical payload. **Canonicalization** (B35 — exact byte sequence, no implementer discretion):
    ```
    canonical = '{"choiceId":"<choiceId>","expectedVersion":<n>,"readerId":"<readerId>","sessionId":"<sessionId>"}'
    ```
    - `<choiceId>`, `<readerId>`, `<sessionId>`: UUIDs lowercased (input casing normalized before hashing).
    - `<n>`: `expectedVersion` as a bare JSON integer — no quotes, no decimal point, no whitespace anywhere in the payload.
    - Key order fixed: `choiceId`, `expectedVersion`, `readerId`, `sessionId` (alphabetical).
    - Bytes: UTF-8 encoding of the canonical string. Fingerprint: lowercase hex of SHA-256 over those bytes.
    - One shared canonicalization function is used by the route handler and all test helpers.
    - **B36 amendment (2026-10-13, STOP-1 review)**: Fingerprint updated to 4 fields with `readerId` (from the authenticated session, never client input). The key namespace is per-reader, eliminating the cross-reader existence oracle. Previous 3-field vectors in this section are superseded.
    - Test vectors (normative, 4-field):
      - `choiceId=22222222-2222-4222-8222-222222222222`, `expectedVersion=3`, `sessionId=11111111-1111-4111-8111-111111111111`, `readerId=33333333-3333-4333-8333-333333333333` → `aa4f30ed886db1d84f3e9c2635412c9e9b321256f2643bd58b6b7afd94d3845d`
      - Same UUIDs, `expectedVersion=42` → `57efef3f3189105ac6fff3ea52397cc701daf92573ccf6c9268ce01cb2dd5b38`
      - Uppercase `choiceId=AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE` → normalized → `1f3bb985fa0de866ce292ed65e404cb2edcfe1e4517f2d7bf365610d3bc37921`
3. Early idempotency lookup (unexpired records only):
   - Hit + same fingerprint + same session → **replay the stored response data**, no further work.
   - Hit + different fingerprint → **409** (key reuse across different logical submissions is never silently executed twice).
   - Hit + same key but recorded for a **different session** → **409** (keys are globally unique; a stored key replays only for its original session and fingerprint).
   - Miss, or record expired → proceed. Expired records are treated as misses. (This lookup is read-only: it never deletes. Deletion of expired rows happens only inside the transaction at step 8/15, so a rolled-back request persists nothing — the "zero writes" invariant below holds absolutely.)
4. New submission only (fast path): `requireActive` on the loaded session — terminal → `SessionTerminalError` → **409**. (The authoritative check repeats in-transaction at step 9; a session that completes between here and the lock is caught there.)
5. Load the session's pinned canon snapshot (immutable — safe pre-transaction); corrupt → 500 (ADR-014 D1, never silent fallback).
6. Find the choice in the pinned canon: unknown `choiceId` → 404. (Existence only — the canon is immutable, so this is stable pre-transaction. Scene attachment is checked in-transaction at step 11, after the authoritative version check, so a stale client receives 409 — never a masked 422 — per B30.)

**Transaction** (single; F2a mechanism extended):

7. `SELECT … FOR UPDATE` the session row (vanished concurrently → 404).
8. **Re-check the idempotency key** → if a record exists that is unexpired, fingerprint-matching, and session-matching → **ROLLBACK** (nothing written) and return its stored response data. If a record exists but the fingerprint differs → **409**, ROLLBACK. If the record's session differs → **409**, ROLLBACK. If the record is expired → delete it **inside this transaction** and treat as a miss (proceed). This covers the race where a winner committed between the early lookup (step 3) and our lock acquisition: the loser waits on the row lock, then finds the winner's record instead of failing the version check. ("Zero writes" on failure paths means zero *committed* writes: the expired-row delete is undone by the same ROLLBACK.)
9. **Authoritative active check**: terminal → 409, ROLLBACK. (A session that completed after the step-4 fast path is caught here, before any evaluation.)
10. **Version check** vs `expectedVersion` → mismatch → **409** with `report.currentVersion`, ROLLBACK. This is the authoritative check, against the locked row.
11. **Placement check** (B30): the choice must be attached to the **locked** session's `currentSceneId` → else **422** `ChoiceNotAttachedError`, ROLLBACK, zero writes. Checking attachment here — after the lock and the authoritative version check — preserves version precedence: a stale client always receives 409 at step 10, never a masked 422.
12. Evaluate `choice.conditions` against the **locked** current state → false → **422** `ChoiceNotAvailableError`, ROLLBACK, zero writes. Condition parse failures follow D1a's marker-dependent policy (unparsable legacy condition → choice unavailable, 422; unknown op in a marked snapshot → 500) — they never evaluate as false.
13. Apply `choice.mutations` **in memory** against the locked state via `applyMutations` → `{ state: newState, applied }`. Two distinct failure classes, per the D1a two-phase boundary:
    - *Parse failure* (unknown operator or malformed shape) → follows the marker-dependent policy: **500** for marked snapshots, **422 fail-closed** for legacy snapshots. `MutationApplicationError` is never used here.
    - *Applicability failure* (well-formed mutation that cannot apply to the current state — D1a table) → **422** `MutationApplicationError`.
    In both cases: ROLLBACK, zero committed writes.
14. Entity transition — **one atomic domain operation**: `applyChoiceResult(toSceneId, newState, { isEndingTarget })`. Scene, state, exactly one version increment, timestamp, and final status update together; the entity derives `completed` vs `active` from `isEndingTarget` (B23 — no flaggable mismatch). There is no intermediate state in which the entity is terminal-yet-untransitioned or double-incremented.
15. **Construct the complete response in memory** (before any write, so a construction failure still rolls back cleanly):
    - If the transition completes the session (ending target) → `availableChoices: []`. Choice evaluation is skipped entirely: a completed session is absorbing and must not advertise another executable choice.
    - Otherwise, evaluate the target scene's choices against `newState` with the **same marker-dependent policy as D1a** (B16): a marked snapshot with an unparsable condition in any target-scene choice → **500** (canon invariant violation), ROLLBACK, zero committed writes; a legacy snapshot with an unparsable condition → that choice is excluded (fail closed), while legacy `{}` counts as unconditional (included).
    - **B33 — this is intentional.** An unrelated malformed sibling in a marked snapshot fails the *whole* submission, even when the selected choice is valid. Rationale: a marked snapshot carries publish validation's guarantee that *every* condition parses; one violation proves the canon is corrupt (bad publish, drift, tampering), and the corruption is not safely localizable — excluding the sibling and continuing would compute `availableChoices` against a scene we know is corrupt, which is the silent reinterpretation B9 forbids. This matches the ADR-014 D1 fail-loud precedent for corrupt canon. The failure occurs at step 15, before any write at step 16: the ROLLBACK covers the session `UPDATE`, timeline `INSERT`, and idempotency `INSERT` (none yet written) plus the step-8 expired-row delete — zero committed writes, confirmed by the B28 test.
    - Assemble `{ sessionId, version, currentSceneId, status, appliedMutations: applied, availableChoices }`.
16. Persist atomically: `UPDATE` the session row (**including `status`** — the current F2a `UPDATE` omits it; G2 extends the repository method additively), `INSERT` the timeline row (`state_diff` = the exact envelope `{ "kind": "choice-execution-v1", "applied": [...] }` per D1b — not the bare list; gapless `MAX+1` under the row lock), `INSERT` the idempotency record carrying the constructed response → **COMMIT**. Any failure → ROLLBACK: zero partial writes (NFR-03), and no cached response exists for a rolled-back transition. Invariant: the transition, its timeline row, and its replayable response commit together — a post-commit delivery failure is still retry-safe via the stored record.
17. Unique-violation on the idempotency `INSERT` → run the **recovery algorithm** (below) — backstop for cross-session races and any residual insertion race; same-session races are already resolved by step 8.

**Post-transaction**: return the committed response (which is also what steps 3 and 8 replay).

### D3a — Unique-violation recovery algorithm (B11)

PostgreSQL aborts the transaction on a unique violation: no further commands are possible inside it, and the conflicting `INSERT` blocked until the winner committed or rolled back — so reaching this path implies the winner **committed** (had it rolled back, our `INSERT` would have succeeded).

1. **ROLLBACK** the aborted transaction. (Mandatory first step: the re-read must happen after rollback, never inside the failed transaction.)
2. Re-read the key in a fresh read (new transaction or auto-commit query) and apply the **same comparison rules as the ordinary lookup**:
   a. Record found, unexpired, same fingerprint, same session → return its response data. (The winner's successful response.)
   b. Record found, unexpired, **different fingerprint or different session → 409 Conflict.** Never replay the winner's response here — it belongs to a different logical submission.
   c. Record found but **expired** → treat as a miss → one bounded retry of the submission from step 1.
   d. Record **absent** → one bounded retry of the submission from step 1. (Defensive: unreachable given the blocking semantics above, unless the winner's row was deleted between commit and re-read.)
3. The retry is bounded to **one attempt** and **does not re-enter this recovery algorithm**: if the retry itself hits a unique violation (or any other unresolvable state) → **500** with a server-side log, immediately. Exhaustion of the single retry always terminates in the defensive 500 — recursion is structurally impossible, so no livelock is possible.

Evaluation (steps 12–13) is synchronous, in-memory, and allocation-light — comfortably inside NFR-01's 100ms budget; the transaction dominates latency as in F2a.

**Response fidelity note**: the stored response is PostgreSQL `JSONB`. The contract guarantees **identical response data** (deep-equal), not byte-for-byte HTTP replay — JSONB does not preserve the original serialization. Replays re-serialize the stored data. This is sufficient for retry safety: the client receives the same version, scene, status, mutations, and choices.
## 5. D4 — Validation summary

| Layer | Rule | Failure |
|---|---|---|
| Transport (Zod) | body shape, UUID formats, `expectedVersion` positive int, idempotency-key UUID | 400 |
| Auth | session cookie valid, reader role | 401 |
| Ownership | `session.reader_id == request.user.userId` | 404 (not 403) |
| Idempotency | key reuse with different fingerprint, or key scoped to another session | 409 |
| Lifecycle | session `active`: pre-tx fast path for new submissions + authoritative in-tx check after lock (both after idempotency replay) | 409 |
| Choice existence | `choiceId` in pinned canon | 404 |
| Choice placement | choice attached to current scene | 422 |
| Choice availability | conditions evaluate true | 422 |
| Mutation applicability | well-formed mutation that cannot apply to current state (in memory, in-tx after lock, before any writes) | 422, nothing written |
| Optimistic locking | `expectedVersion` match | 409 + `currentVersion` |
| Data integrity | corrupt canon / unknown condition op at runtime / **malformed mutation in a marked snapshot** (parse failure — distinct from 422 applicability failure) | 500 |

**Error-type separation** (B24): the use case throws distinct error classes, and the route's error mapper must preserve the distinction — a broad `catch` that collapses parse failures into 422 would silently violate the D1a policy:
- `CanonInvariantError` → 500 (marked-snapshot parse failures: unknown operator, malformed shape, non-finite operand).
- `LegacyPayloadRejectedError` → 422 (legacy fail-closed: unparsable condition/mutation where the snapshot predates G1 validation).
- `MutationApplicationError` → 422 (well-formed mutation inapplicable to current state).
- `StateInvariantError` → 500 (B37: the applier produced schema-invalid state — a server bug; thrown in memory before any write).
- `StoredResponseCorruptError` → 500 (B38: stored idempotency response fails the response schema on replay; never served).
Acceptance: a route-level test drives a malformed mutation through the full HTTP stack for a marked snapshot and asserts **500** (not 422), and for a legacy snapshot asserts **422** — proving the mapper preserves the boundary end to end.

SEC-03: all reader-supplied values (`choiceId`, `expectedVersion`, idempotency key) are validated at the boundary; `var` names come only from published canon, never from the reader.

---

## 6. D5 — Transaction boundaries

**Decision (product-owner corrected, 2026-10-13)**: the idempotency **lookup** happens before the lifecycle/version checks (D3 steps 2–3); the idempotency **write** happens **inside** the same transaction as the state/timeline commit (D3 step 16), so a cached response can never exist for a rolled-back transition. G2 otherwise reuses the F2a transaction verbatim — no new locking scheme. Concurrent same-key requests are serialized by the `PRIMARY KEY (idempotency_key)` unique constraint: the loser rolls back and replays the winner's committed response (D3).

**In-memory entity discipline** (B26): `applyChoiceResult` mutates the session entity before persistence, and a database ROLLBACK cannot undo that in-memory mutation. Therefore: on any ROLLBACK, the mutated entity is **discarded** — never returned, never reused as authoritative state, never re-attached to a retried transaction. Subsequent reads re-fetch the session row from the database. The bounded D3a retry starts from a fresh load (D3 step 1), never from the discarded entity.

---

## 7. D6 — Idempotency-key storage

**Decision (product-owner approved 2026-10-13)**: migration `006_idempotency_keys`:

```sql
CREATE TABLE idempotency_keys (
  idempotency_key UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES reader_sessions(session_id) ON DELETE CASCADE,
  request_hash CHAR(64) NOT NULL,          -- sha256 of canonical payload
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON idempotency_keys (expires_at);
```

- **Key scope** (B31 — terminology clarified): keys are **globally unique** (`idempotency_key UUID PRIMARY KEY`). "Session-scoped" in earlier drafts was imprecise: what is session-bound is the *replay*, not the key namespace. A stored key replays a response **only** for its original session + fingerprint; the same key presented with a different session or fingerprint → **409**. Cross-session reuse never replays and never overwrites — the PK constraint plus D3a recovery enforce this.
- **Expiry** (product-owner decision 2026-10-13): 24h retention per ADR-013 D3. **An expired record must never block a legitimate retry** — correctness does not depend on cleanup having run.
- **Expiry boundary** (B34 — one predicate everywhere): a record is expired ⟺ `expires_at <= now()`. Equality counts as expired. The comparison is always performed **in SQL on the database clock** — never in application code — uniformly across the early lookup (D3 step 3), the in-transaction recheck (D3 step 8), the periodic cleanup `DELETE`, and the D3a recovery re-read. Inside a transaction, `now()` is the transaction-start timestamp, so the boundary is stable for the transaction's lifetime; in auto-commit reads it is the statement timestamp. No operation may use a different predicate or a client-side clock.
- **Expired-key reclamation protocol** (authoritative; B15). Expired rows are reclaimed **only inside a transaction** or by the periodic cleanup — never as a committed side effect of the pre-transaction read-only lookup (D3 step 3 treats expired as a miss without deleting):
  1. In-transaction recheck (D3 step 8) finds an expired record → `DELETE` it in the same transaction → proceed as a miss.
  2. Step 15 `INSERT`s the fresh record (`expires_at = now() + 24h`).
  3. Races:
     - Cleanup deletes the expired row between the pre-tx lookup and the in-tx recheck → recheck finds nothing → miss → proceed. Safe.
     - Two transactions both find the same expired row in-tx → both `DELETE`; the second blocks until the first commits or rolls back. If the first commits (its fresh `INSERT` precedes commit), the second's `DELETE` affects 0 rows and its `INSERT` then conflicts with the winner's uncommitted row → unique violation → D3a recovery → re-read finds the winner's fresh **unexpired** record → fingerprint/session compare → replay or 409. Correct.
     - If the first rolls back, the second's `DELETE`+`INSERT` proceed normally. Correct.
     - Cleanup never deletes a fresh row (it only deletes `expires_at <= now()`; fresh rows expire in 24h). No race between cleanup and a live submission's `INSERT`.
  4. Invariant: a rolled-back request persists nothing — including no reclamation delete. "Zero committed writes" holds absolutely.
- **Refinement requirement** (B32): the prose above describes the intended interleavings, but prose is not evidence. During G2 task refinement, the implementer must specify the transaction **isolation level** (default `READ COMMITTED` unless a stronger level is justified) and the **exact SQL** for the in-transaction expired-row reclamation, and the B27 PostgreSQL integration test must verify the concurrent-replacement interleaving against the real database. The unique constraint is never weakened and correctness never depends on cleanup timing.
- **Session deletion** (B36 — verified against the repository 2026-10-13): no code path in `src/` or `migrations/` deletes from `reader_sessions` — sessions end via status transitions (`completed`, `abandoned`), never via row deletion. **Session deletion is therefore impossible in the MVP**, and the `ON DELETE CASCADE` on `idempotency_keys.session_id` is purely defensive. Contract if deletion ever becomes possible: the idempotency rows vanish with the session; a retry with the same key finds no record → proceeds as a new submission → fails at D3 step 1 with **404** (session not found). A deleted session can never cause a replay of another session's response — the session lookup precedes every replay path.
- **Cleanup**: bounded periodic `DELETE FROM idempotency_keys WHERE expires_at <= now()` (e.g. a lightweight interval in the app runtime or a scheduled task; no full job framework in MVP) **plus** lazy in-transaction reclamation on read. The periodic job is an optimization, not a correctness mechanism.
- **Change classification: Level 3** (new persistent data + new API contract + new domain services). Requires the migration/compatibility analysis and full review the workflow mandates for Level 3.

---

## 8. D7 — Minimum test matrix

**G1 (ROADMAP gate: 100% unit coverage of pure functions)**:
- Truth tables for every condition op (`and`/`or`/`not` nesting, `eq`/`ne` across JSON types incl. deep equality with key-order-insensitive objects, numeric comparisons, `has` vs `in` non-overlap).
- Missing-var → false; type-mismatch → false; `has` on null-valued key → true; empty `and`/`or` arrays rejected by the semantic validator (publish-time test).
- Mutation applier: `set`/`inc`/`dec`/`toggle`/`unset`, ordering effects; `inc`/`dec` on missing var → error; on non-numeric → error; non-finite `by` → error; overflow to `Infinity`/`NaN` → error; `toggle` on non-boolean → error; missing → `true`.
- Determinism: repeated evaluation byte-identical; no `Math.random`/`Date`/implicit coercion in the evaluator (static check or review).
- Semantic validator: unknown op → invalid; malformed shapes → invalid; overlong `var` / excessive nesting / non-finite literals → invalid; `__proto__`/`constructor`/`prototype` keys → invalid (C3); valid grammars pass.

**G2**:
- Unit (fakes): happy path (complete resulting state incl. `unset` deletion semantics + scene change + available choices with exact response schema; timeline row asserts the discriminated `{ kind: "choice-execution-v1", applied }` envelope); 404 unknown/wrong-owner session; 404 unknown choice; 422 choice-elsewhere; 422 conditions-false (zero writes); 422 invalid mutation (zero writes, typed error); 409 terminal (pre-tx fast path and in-tx authoritative check); 409 version mismatch (zero writes, `currentVersion` present); ending target → `completed` with **exactly one version increment** and status persisted; idempotency hit-same → replay without re-execution; hit-different-fingerprint → 409; hit-different-session → 409; **retry after completion replays the stored success response** (never 409-terminal); expired record treated as miss; **stale version + failing condition → 409 (not 422)** — version precedence; unconditional choice: absent conditions accepted, `{}` rejected at publish validation.
- Integration (real PG): end-to-end choice progression with timeline rows and version increments; concurrent submissions on one session → exactly one succeeds per version (409 for the loser); idempotency key retried across the wire returns identical response data with a single timeline row; **concurrent same-key requests where the loser waits on the row lock → loser replays winner's response** (in-tx recheck path); **old snapshot reads** (marker absent); **legacy `{}` condition executes as unconditional**; legacy unparsable condition → choice unavailable (422), session otherwise functional; **unknown mutation operator in a marked snapshot → 500 with zero committed writes** (parse failure, not applicability); **unknown mutation operator in a legacy snapshot → 422 fail-closed with zero committed writes**; **cross-session same-key race** (B21): two different sessions submit the same idempotency key concurrently → exactly one commits a transition; the loser's D3a recovery returns 409 (different session) with **no committed session transition or timeline row** on the loser's session; **expired-key + cleanup race** (B27): concurrent reuse of an expired key while the periodic cleanup deletes expired rows → bounded termination, correct response ownership, no duplicate committed transition; **response-construction failure** (B28): marked snapshot with a valid selected choice but a malformed sibling choice in the target scene → 500 at step 15 with session row, timeline, and idempotency record all unchanged (version not incremented).

### Coverage gate (G1)

"100% unit coverage" means **100% line, branch, function, and statement coverage** on the G1 pure modules, measured with `vitest --coverage` (v8 provider) with thresholds set to 100 for those files. The gated modules are: the condition evaluator, the mutation applier, the grammar parsers (Zod schemas), the semantic validator, the marker-presence helper (`hadMarker`/`effectiveVersion`), and the parse-vs-applicability error-policy boundary (B29) — every error path (unknown op, malformed shape, nesting-limit breach, per-op mutation rejections, non-finite operand vs. non-finite result, legacy fallback branches) must be executed by at least one test. Line coverage alone is insufficient, and meeting the threshold on the evaluator/applier/validator while leaving the parser or marker boundary untested does not satisfy the gate.

### Timeline consumer inventory (B25)

D1b requires every reader of `reader_timelines.state_diff` to support both the legacy bare-object form and the `{ kind: "choice-execution-v1", applied }` envelope. During G2 task refinement, the implementer must perform a repository-wide search for all readers of this column (repository methods, API serializers, any analytics/export code) and record each in the task spec with either a test covering both shapes or a documented justification for why it cannot observe G2 rows. The timeline compatibility work is not complete when the writer changes — it is complete when the consumer inventory is closed.

### Performance gate (NFR-01)

Two measurements, both under single-user baseline conditions:
- **Pure evaluation budget**: the G1 evaluator + applier over a max-bounds payload (depth 10, 100 nodes, 50 mutations) must complete in **<10ms** (benchmark test, no I/O). This is a design allocation, not the NFR itself.
- **End-to-end NFR-01**: choice submission p95 **<100ms** against local PostgreSQL, single user, warmed connection pool — measured over the **full path**: request handling, transaction open, row lock, condition evaluation, mutation application, entity transition, response construction, session `UPDATE`, timeline `INSERT`, idempotency `INSERT`, and commit. Not pure evaluation alone. The §2 numeric limits are MVP constraints (tested at their boundaries); they bound input size but are not claimed to guarantee the 100ms target — the benchmark and p95 measurement do.

---

## 9. Product-owner decisions (recorded 2026-10-13)

All six open questions are decided. Evaluated against four invariants: **determinism** (identical canon + state + valid choice → identical transition), **atomicity** (rejected/failed choice → zero partial writes), **retry safety** (same logical submission never applies twice, even if the client loses the response), **version integrity** (stale submissions can't overwrite newer state; 409 carries `currentVersion` for resync).

Note: the decisions below record the product owner's direction. Specific numeric constants in §2 (`var` max 128 chars, nesting depth 10 / 100 nodes / 50 mutations) are proposed values inside the approved constraints — say the word if you want different bounds.

1. **Grammar — approved with constraints** (§2): strict tagged objects, discriminated unions; operand types, missing-value behavior, `has`/`in` semantics, nesting limits (depth 10, 100 nodes, 50 mutations), and finite-numeric rules defined explicitly. Evaluation and mutation application stay pure: no AI calls, no DB access, no implicit coercion, no wall-clock dependence.
2. **Runtime unknown-op — approved: 500 fail-loud.** Unknown operator in immutable canon is an invariant violation, not a client error. Generic 500 response; internal diagnostic logged server-side; session state untouched. Known operators with missing/incompatible operands keep the safe-false semantics — this rule never swallows unknown operators.
3. **`inc`/`dec` on non-numeric — reject with 422, never coerce.** Missing var, non-numeric value, or non-finite arithmetic **result** → typed `MutationApplicationError`, complete rollback, nothing written. A non-finite **operand** (e.g. non-finite `by`) is a grammar violation → Phase 1 parse failure (500 marked / 422 legacy fail-closed), not an applicability error. `dec` shares the rules. Conditions may evaluate false on bad data; mutations must not silently become no-ops.
4. **Abandon route — separate Phase F closure, not G2 scope.** New follow-up task: `POST /sessions/:id/abandon` (clearer than `DELETE`, which implies deletion). Auth + ownership (404-not-403); active → `abandoned` via the entity; already-`abandoned` → 200 replay of current state (retry-safe, no new transition); `completed` → 409 (absorbing terminals admit no new transitions). Takes `expectedVersion` and persists through the F2a-style transaction for race safety. **Retry semantics**: the 200-replay for an already-abandoned session does not consult `expectedVersion` (the outcome is terminal and recorded; there is nothing to conflict with). A repeat abandon against an **active** session with a stale `expectedVersion` → **409** like any other state-changing write — the client re-reads via `GET /sessions/:id` and retries. **Abandonment timeline (resolved)**: no `reader_timelines` row is written for abandonment. The session row's `status = 'abandoned'` + `updated_at` is the record. Rationale: the timeline records choice executions; inventing a synthetic `choice_id` would corrupt its meaning, and making `choice_id` nullable would weaken a meaningful NOT NULL constraint for a non-choice event. If abandonment audit history is later required, that is a schema change for the follow-up task — not this ADR.
5. **Idempotency cleanup — approved with constraints** (§7): persistent record with session scope, key, request fingerprint, response payload, expiry; unique constraint serializes same-key races; expired records are treated as misses (lazy delete) so a delayed cleanup can never block a legitimate retry; bounded periodic cleanup as an optimization only.
6. **Response shape — approved** (§3): exact schemas defined for `appliedMutations` (discriminated: value-bearing ops vs `unset` with `removed: boolean`) and `availableChoices` (choiceId/text/sortOrder only — no conditions, mutations, or target scenes). Idempotent retries replay the stored response **data** (deep-equal; JSONB does not preserve byte order), never recomputed.

### Review round 2 — blocker resolutions (2026-10-13)

All six blockers from the design review are resolved in this revision:

- **B1 (idempotency race)**: key re-checked inside the transaction after the row lock (D3 step 8); unique-constraint conflict/re-read retained as backstop.
- **B2 (version masking)**: authoritative version check precedes state-dependent evaluation, both inside the transaction on the locked row (D3 steps 10–12).
- **B3 (entity lifecycle)**: one atomic `applyChoiceResult(toSceneId, newState, { complete })` — single version increment, status set atomically; the F2a repository `UPDATE` is extended additively to persist `status` (verified: the current statement omits it). *(Signature refined in round 6 per B23: `{ isEndingTarget }`, completion derived structurally.)*
- **B4 (grammar/test contradiction)**: `and`/`or` arrays are non-empty (publish blocker if empty); unconditional = absent `conditions`; `{}` rejected at publish; test matrix updated.
- **B5 (canon compatibility)**: §10 — marker is optional-with-default; per-choice conditions/mutations stay loose in the canon transport schema; strictness lives at publish time and in the runtime evaluator; backfill proven unnecessary (and impossible under the 005 immutability trigger). *(Superseded by B12 in round 4: the schema carries no default; presence is tracked explicitly.)*
- **B6 (unset representation)**: discriminated `appliedMutations` shape (`removed: true` vs value-bearing). *(Superseded by B7 in round 3: `removed: boolean`.)*

Clarifications folded in: per-operation missing-var table (D1a); `in.values` accepts any `JsonValue[]` with deep equality (consistent with `eq`); response fidelity = deep-equal data; expired-key concurrency coordination (§7).

### Review round 3 — resolutions (2026-10-13)

- **B7 (`unset` response)**: discriminated shape uses `removed: boolean` — actual deletion vs. no-op on absent key are distinguished; never conflated with `null`.
- **B8 (shallow-merge vs `unset`)**: new D1b — the pure applier returns the complete resulting state plus the applied list; new entity method `applyChoiceResult` replaces state wholesale (F2a's `applyTransition` untouched). *(Timeline representation refined in round 4: the discriminated `{ kind: "choice-execution-v1", applied }` envelope, not the bare list.)*
- **B9 (execution compatibility)**: read vs. execution compatibility distinguished (§10). Legacy `{}` grandfathered as unconditional (documented pre-G1 semantic); other unparsable legacy payloads fail closed (choice unavailable / mutation rejected, 422); marked snapshots with unparsable content → 500. Nothing is silently reinterpreted.
- **B10 (response before commit)**: D3 steps 14–15 — response constructed in memory from the computed resulting state (including next-scene available choices), then session + timeline + idempotency record commit atomically. Post-commit delivery failure remains retry-safe via the stored record.
- Clarifications: step 8 recheck semantics spelled out (replay / 409 / expired-delete); negative finite `by` permitted and documented; coverage gate = 100% line+branch+function+statement on G1 modules; performance gate = <10ms pure-evaluation budget + p95 <100ms end-to-end, limits treated as MVP constraints; abandonment retry semantics with stale `expectedVersion` → 409.

### Review round 4 — resolutions (2026-10-13)

- **B11 (cross-session idempotency race)**: new D3a — complete unique-violation recovery algorithm: ROLLBACK first (PostgreSQL aborts the tx; re-read must happen after), then re-read with the same comparison rules as ordinary lookup (replay / 409 / bounded single retry). The blocking semantics of the conflicting INSERT guarantee the winner committed before the violation surfaces.
- **B12 (defaulted marker)**: schema is `z.literal(1).optional()` with **no default**; presence is tracked explicitly (`hadMarker` vs `effectiveVersion`) at the execution boundary. A schema default can never erase the legacy/validated distinction because none is defined.
- Consistency fixes: "zero writes" = zero *committed* writes (expiry cleanup only in-tx); timeline `state_diff` uses the discriminated `{ kind: "choice-execution-v1", applied }` envelope with both shapes tested; happy-path test asserts complete state + deletion + envelope; two-phase parsing boundary (unknown op → 500/422-fail-closed at parse, never misclassified as precondition failure); applier works on a deep copy and returns nothing until all mutations succeed.

### Review round 5 — resolutions (2026-10-13)

- **B13 (timeline envelope mismatch)**: the persist step now names the exact persisted value — `{ "kind": "choice-execution-v1", "applied": [...] }` — matching D1b; the bare list is never persisted. *(Step renumbered to 16 in round 7.)*
- **B14 (overbroad mutation step)**: the apply-mutations step now distinguishes parse failures (marker-dependent policy: 500 marked / 422 legacy fail-closed; `MutationApplicationError` never used) from applicability failures (422 `MutationApplicationError` only for successfully parsed mutations). Zero committed writes in both cases. *(Step renumbered to 13 in round 7.)*
- Consistency checks: D4 error matrix lists malformed marked mutations under 500 data-integrity, distinct from 422 applicability; integration matrix adds unknown-mutation-operator cases for marked (500) and legacy (422) snapshots with zero-committed-writes assertions; D3a retry explicitly cannot re-enter the recovery algorithm (exhaustion → defensive 500); the end-to-end p95 benchmark is specified over the full path including transaction, timeline write, and idempotency persistence.

### Review round 6 — consolidated audit resolutions (2026-10-13)

Design/contract (B15–B20):
- **B15 (expired-key reclamation)**: §7 now carries the authoritative protocol — reclamation only in-tx or via periodic cleanup; the four race cases (cleanup-before-recheck, dual in-tx delete, rollback interleaving, cleanup-vs-fresh-insert) each specified with the correct outcome; "zero committed writes" holds absolutely.
- **B16 (next-scene filtering)**: the response-construction step applies the D1a marker-dependent policy to target-scene choices — marked/unparsable → 500 with rollback; legacy/unparsable → excluded (fail closed); legacy `{}` → included as unconditional. *(Step renumbered to 15 in round 7.)*
- **B17 (non-finite operands)**: D1a table and §9.3 split non-finite `by`/literals (Phase 1 parse failure → marker-dependent policy) from non-finite arithmetic results (Phase 2 applicability → 422).
- **B18 ("at canon parse")**: D1 now states strict parsing happens at publish time and at the execution boundary per choice — never by revalidating the whole stored snapshot on read (transport stays loose per §10).
- **B19 (completed sessions)**: the response-construction step returns `availableChoices: []` for ending targets and skips choice evaluation entirely — a completed session never advertises another executable choice. *(Step renumbered to 15 in round 7.)*
- **B20 (absent mutations)**: absent `mutations` ≡ `[]` across publish validation, legacy execution, and response construction (`appliedMutations: []`); `null`/non-array is malformed.

Acceptance criteria (B21–B25):
- **B21**: cross-session same-key concurrency integration test (D3a path, not step 8) — 409 for the loser, no committed transition/timeline row on the loser's session.
- **B22**: fingerprint canonicalization specified — lowercased UUIDs, fixed alphabetical key order, bare-number version, no whitespace, UTF-8, SHA-256 hex; one shared function for handler and tests.
- **B23**: entity signature is now `{ isEndingTarget }` with completion derived structurally — the invalid states are inexpressible, not merely unchecked.
- **B24**: three distinct error classes (`CanonInvariantError` → 500, `LegacyPayloadRejectedError` → 422, `MutationApplicationError` → 422) with a route-level acceptance test proving the mapper preserves the boundary end to end.
- **B25**: timeline consumer inventory is a task-refinement gate — every `state_diff` reader found by repository search gets a both-shapes test or a documented justification; the work is complete when the inventory closes, not when the writer changes.

Implementation/test gate (B26–B29, recorded — not ADR architecture):
- **B26**: D5 — mutated entity discarded on ROLLBACK; never returned or reused; retries start from a fresh load.
- **B27**: expired-key + cleanup race integration test (bounded termination, correct ownership, no duplicate commit).
- **B28**: response-construction failure integration test (500 at the response-construction step → session, timeline, idempotency all unchanged). *(Step renumbered to 15 in round 7.)*
- **B29**: coverage gate explicitly includes grammar parsers, marker-presence helper, and the parse-vs-applicability policy boundary.

### Review round 7 — resolutions (2026-10-13)

- **B30 (placement masking version conflict)**: D3 step 6 now checks existence only (404, pre-tx — canon is immutable); scene attachment moved in-transaction to new step 11, after the lock and the authoritative version check. A stale client always receives 409 at step 10, never a masked 422. Steps renumbered 11→17; cross-references updated (D5, evaluation note, B28 test).
- **B31 (key-scope terminology)**: "session-scoped" replaced — keys are globally unique; what is session-bound is the *replay* (original session + fingerprint only, else 409). New "Key scope" bullet in §7.
- **B32 (reclamation concurrency evidence)**: §7 now requires task refinement to specify the isolation level and exact reclamation SQL, with the B27 PG integration test verifying the interleaving — prose is explicitly not a substitute for that verification.
- **B33 (sibling-choice precedence)**: confirmed intentional — a malformed sibling in a marked snapshot fails the whole submission (fail-loud; corruption is not safely localizable; B9 forbids silent reinterpretation). Rollback scope stated explicitly: the failure precedes all writes, so session UPDATE, timeline INSERT, idempotency INSERT, and the expired-row delete are all unwritten — zero committed writes, per the B28 test.

### Review round 8 — resolutions (2026-10-13)

- **B34 (expiry boundary)**: one predicate everywhere — expired ⟺ `expires_at <= now()`, equality counts as expired, always evaluated in SQL on the database clock (transaction-start `now()` in-tx, statement `now()` in auto-commit). No client-side clock, no divergent predicates.
- **B35 (fingerprint bytes)**: exact canonical byte sequence specified with three normative SHA-256 test vectors (including UUID-case normalization).
- **B36 (session deletion)**: verified against the repository — no deletion path exists in `src/` or `migrations/`; deletion is impossible in MVP, CASCADE is defensive. Contract recorded: deletion → retry finds no record → 404 at session lookup, never a cross-session replay.
- **B37 (computed-state validation)**: entity schema check failure → `StateInvariantError` → 500 (server bug, not canon/client fault), thrown in memory at step 14 before any write.
- **B38 (replay validation)**: every replay path validates stored JSONB against the D2 response schema first; failure → `StoredResponseCorruptError` → 500, logged server-side, never served.

### Closure review — resolutions (2026-10-13)

- **C1 (expiry predicate mismatch)**: the cleanup `DELETE` and the reclamation-protocol prose now use `expires_at <= now()`, matching the B34 boundary. No divergent predicate remains.
- **C2 (third test vector)**: the vector now states all inputs and the complete normalized canonical string; the digest was independently recomputed and verified.
- **C3 (special object keys)**: `__proto__`, `constructor`, and `prototype` are rejected as `var` values at the grammar level (publish blocker; runtime marker-dependent parse failure), with a required unit test. Rationale: these keys cannot survive ordinary JS property assignment without prototype pollution; no legitimate narrative needs them.

---

## 10. Consequences

- G1 replaces the opaque `ConditionSchema`/`MutationSchema` with the versioned grammar (authoring-side). The **canon transport schema stays backward compatible** (see compatibility analysis below) — no data migration, no backfill.
- E1b gains publish-time semantic validation (blockers for unknown ops, malformed shapes, nesting/operand violations, empty boolean arrays, `{}` conditions) — a small, additive change to the publishing validator.
- One new migration (006), one new route (`POST /sessions/:id/choices`); the F2a repository method is extended additively (persist `status`; accept the idempotency write in-tx; atomic complete-transition support).
- **New Phase F follow-up task**: `POST /sessions/:id/abandon` (see §9.4) — scoped and specified separately from G2.
- No implementation is authorized by this ADR until the product owner gives final design approval after reviewing this text. On approval: TASKS.md G1/G2 get refined task specs, then Builder implements behind the design gate with the System Completeness evaluation the workflow requires.

### Canon backward-compatibility analysis (Blocker 5, refined B9/B12)

`PostgresCanonRepository.findLatestByWorldId` revalidates stored `canon_data` against `CanonDataSchema` on every read, so any schema change applies to already-published snapshots. The 005 immutability trigger forbids `UPDATE` on `published_canon_snapshots`, so backfill is not just undesirable — it is impossible without violating a deliberate invariant. The analysis distinguishes **read compatibility** (old snapshots parse) from **execution compatibility** (old choices evaluate):

**Read compatibility** (established):
1. **Grammar marker**: added as `condition_grammar_version: z.literal(1).optional()` — **with no schema default**. Old snapshots without it validate. Critically, the schema must not insert a default: a defaulted value would erase the information the execution policy depends on (B12). Instead, presence is tracked explicitly:
   - The transport type keeps the field optional.
   - At the execution boundary, a helper derives both facts from the parsed data: `hadMarker = data.condition_grammar_version !== undefined` and `effectiveVersion = data.condition_grammar_version ?? 1`.
   - `hadMarker === false` → legacy snapshot → legacy failure policy (fail closed, below). `hadMarker === true` → validated v1 → invariant policy (500 on unparsable content). It is structurally impossible for a schema default to erase this distinction, because the schema defines none.
2. **Per-choice conditions/mutations stay loose in the transport schema** (`z.record(z.unknown())`, unchanged). Old snapshots contain arbitrary opaque JSON from the pre-G1 era; strict grammar validation at the transport layer would 500 them on read. Strictness lives where it belongs: publish-time validation (E1b, for new publishes) and the runtime evaluator.

**Execution compatibility** (fail-closed, not silent reinterpretation):
3. A missing marker defaults to 1 **for dispatch only**; the **failure policy** is selected by marker *presence*, not by the defaulted value:
   - Legacy condition `{}` → unconditional (the documented pre-G1 semantic, explicitly grandfathered and tested).
   - Any other legacy condition/mutation payload that does not parse as v1 grammar → **fail closed**: the choice is unavailable (422) / unappliable (422); nothing is guessed, nothing is corrupted.
   - A **marked** (v1) snapshot with an unparsable condition/mutation → **500** (its publish validation should have caught it; invariant violation).
4. Net: an old snapshot always **reads**; its choices **execute** when they conform to (or are grandfathered into) the v1 grammar, and fail closed otherwise. The earlier claim that old snapshots "execute unchanged" is revised to this precise contract.

A future grammar v2 would require its own compatibility analysis per this section's precedent.

---

## 11. Change Classification

**Level 3** — Architecture/Data/Contract change: new API contract (`POST /sessions/:id/choices`), new persistent data (migration 006), new domain services (evaluator, applier, use case), contract change to `ConditionSchema`/`MutationSchema`. Requires: impact analysis (this ADR), architecture review, detailed design (this ADR §§2–7), contract review, migration/compatibility analysis (§7: additive migration; old opaque payloads unread at runtime), ADR (this document), testing strategy (§8), full review, documentation + project-state updates. Not Level 4: no auth/permission model change, no AI authority change, no new external systems.
