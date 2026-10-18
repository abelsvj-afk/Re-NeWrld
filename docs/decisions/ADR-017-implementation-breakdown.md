# Implementation Task Breakdown — ADR-017 Asset Lifecycle & Publication Integrity

**Status:** PROPOSAL — for product-owner review. Design Gate is OPEN for planning only; no implementation authorized until this breakdown (+ the migration plan) is reviewed and approved.
**Baseline:** ADR-017 rev 26 (approved 2026-10-18, commit `303ed528`), source: `hidden_audit/ADR-asset-lifecycle.md`.
**Change classification:** Level 3 (Architecture / Data / Contract) per `governance/AI_AGENT_RULES.md` §5. Several slices touch auth-adjacent fencing — escalate to Level 4 review if scope expands into permission boundaries beyond what the ADR specifies.
**Workflow mapping:** this document = Phase 15 (Task Generation); slices are sized toward the <~4h guideline where practical — several are marked for further splitting by the implementer.
**Prerequisites before any slice:** migration plan approved; System Completeness Gate evaluation recorded in `docs/system-completeness.md` (per `AGENTS.md` §2 — required before implementation); `docs/decisions/ADR-017-asset-lifecycle-and-publication-integrity.md` is the contract (code conforms to it, not vice versa, per `AI_AGENT_RULES.md` §4).

**Conventions for every slice:**
- Lock order is §4.3c (positions 0–9); new code must acquire locks in ascending order — a new lock edge is a spec bug.
- `is_maintenance_active()` is the ONLY permitted maintenance-state read (S55); direct `SELECT active FROM system_maintenance` is rejected in review.
- `READ COMMITTED` + locks-first-scan-second (§4.2b); `REPEATABLE READ` forbidden for scan-then-act.
- Evidence standards per `AGENTS.md` §2: "implemented" vs "verified" distinguished; UNVERIFIED marked with the exact commands to verify.
- Each slice lists its proving scenarios; implementation is verified slice-by-slice against them.

---

## Slice dependency graph

```
MIG-0 (migrations 014/015 + DDL conformance tests)
 ├─ RES-1 (reservation protocol) ─┬─ QUOTA-1 (quota admission + handoff)
 │                                └─ UPLOAD-1 (upload path rework) ─┐
 ├─ DEL-1 (deletion T1/T2) ───────┬─ DEL-2 (world deletion T1–T5)    │
 ├─ REF-1 (reference validation) ─┼─ SHARE-1 (shared assets+snapshot refs + serving)
 ├─ FENCE-1 (maintenance fence) ──┴─ RECOV-1 (recovery authorization)
 ├─ OPS-0 (volume provisioning — operator procedure, parallel track)
 └─ BF-1 (backfill runner) ── DRIFT-1 (drift resolution)
        └─ OPS-1 (runbooks: restore, diagnose/repair, capacity job)
API-1 (API surface: DELETE endpoint, error contracts) needs UPLOAD-1 + DEL-1 + SHARE-1
```

Slices marked **[migration-first]** require 014/015 applied before their tests can run.

---

## MIG-0 — Migrations 014/015 + DDL conformance tests [migration-first]

**Scope:** Author `db/migrations/014_media_durable_ops.sql` and `015_media_registry.sql` exactly per `migration-plan-ADR-017.md` §1–3; add `tests/integration/migration-014-015.test.ts` (fresh-DB run, idempotency re-run, DDL conformance probes).
**ADR sections:** §4.1 (DDL), §4.3d (system_maintenance, recovery_authorizations), §4.7 (backfill tables), §4.9 (world_deletion_jobs), §5.5 (storage_reservations).
**Acceptance criteria:**
- All 10 tables + 11 indexes + trigger + function + constraints exist after fresh `runMigrations()`; `system_maintenance` singleton row present.
- Second `runMigrations()` run: zero errors, schema unchanged (idempotency).
- S57: deliberately broken migration variant rolls back fully in a scratch DB (test-only).
- S46 step 17 (rev 26): six CHECK-conformance probes pass (NULL-subtype rejected; valid rows accepted; non-drift-with-fields rejected; bad subtype rejected; NULL arrays rejected).
- Rev-20 roles tests: six trigger/CHECK probes pass (duplicates → `check_violation`; bad value → CHECK; `{}` accepted; update-duplicate rejected; reorder accepted; NULL rejected).
- Single-active-run partial unique index: second `in_progress` insert → unique violation. `one_unrevoked_recovery_auth`: two unrevoked → violation; revoked+unrevoked → allowed.
- DDL blocks pglast-parseable.
**Dependencies:** migration plan approval. **Blocks:** every other slice.
**Split note:** if large, split into MIG-0a (014) / MIG-0b (015).

## OPS-0 — Fly volume provisioning (§2.1) [operator procedure, parallel track]

**Scope:** Execute the ADR §2.1 eleven-step staged volume migration as an operator runbook: inventory → provision `media_data` → staging machine (`MIGRATION_STAGING=true`, mount at `/data/media_new`) → transfer → freeze → final inventory → verify → cutover (stop orig, reconfigure staging, restart) → verify → 9f fate decision → backfill prerequisite satisfied.
**ADR sections:** §2.1 (full procedure), §9.2 (topology constraint: single machine while on volume).
**Acceptance criteria:**
- S27: cutover rollback demonstrated (original machine restartable until 9f decision recorded).
- SHA-256 inventory match at steps 7–8; health `/health` 200 with `media_storage` not degraded at 9e.
- `fly.toml` documents volume name/size/mount; single-machine constraint recorded in deployment docs.
**Dependencies:** owner decisions (§7.2 of migration plan: size, region, retention window). **Blocks:** BF-1 (backfill must not run on ephemeral storage).
**Note:** application support needed — `MIGRATION_STAGING=true` startup behavior (don't bind HTTP / bind 127.0.0.1 only). Implement as part of this slice or UPLOAD-1; decide at review.

## RES-1 — Storage reservation protocol [migration-first]

**Scope:** `storage_reservations` repository + Phase-1 (check-and-reserve under level-1 + quota lock) + Phase-2 (deterministic temp path, heartbeats with epoch increment, fenced chunk writes with `flock` handshake, safe-open protocol, lock-release ordering) + expiry-claim worker (candidate selection, 60s observation, mtime grace, epoch CAS, `LOCK_EX|LOCK_NB` fenced claim, path-vanished/absent sub-protocols) + state transitions (COMMITTED/ROLLED_BACK/ABANDONED/CLEANED).
**ADR sections:** §5.5 (entire reservation protocol), §4.3c (lock positions 1–2), §4.3d (B8 invalidation interaction).
**Acceptance criteria (scenarios):**
- S43: accounting conservation — no double-count, no gap across all transitions.
- S38: concurrent uploads respect capacity reservation.
- S45: ENOSPC during write → cleanup or ABANDONED reclassification.
- S51: deployment `flock` self-test passes.
- S52: fencing failure cases (lock released before commit detected; inode identity).
- S53: Domain-R exclusion — Phase-2 writes without level-1, no cross-file interference.
- S5 (partial): outstanding reservations visible to concurrent Phase-1s.
**Dependencies:** MIG-0. **Blocks:** QUOTA-1, UPLOAD-1.
**Split note:** large — split into RES-1a (Phase-1 + repository), RES-1b (Phase-2 writer obligations), RES-1c (expiry-claim worker).

## QUOTA-1 — Quota admission + atomic handoff [migration-first]

**Scope:** `quota_used_bytes(world_id)` = registered_usage + outstanding_reservations (§5.1, single definition used by every path); Phase-1 admission check (507 `QUOTA_EXCEEDED` with `quota_mb`/`used_mb`); atomic reservation→registry handoff (reservation→COMMITTED + asset INSERT in one commit); `MEDIA_WORLD_QUOTA_MB` config wiring (default 50, owner-confirmed value); 10 MB/file limit enforcement (413).
**ADR sections:** §5.1, §5.2, §5.3, §9.3 (status codes).
**Acceptance criteria:**
- S5: 45/50 + two 4 MB concurrent uploads → exactly one proceeds; handoff moves 4 MB buckets atomically; delete reclaims.
- S6: upload racing deletion serializes correctly.
- S15: `pending_deletion` still counts toward quota.
- S34: disk exhausted → 507 `STORAGE_FULL` (distinct from `QUOTA_EXCEEDED`).
- S37: stale capacity metric → 503 `STORAGE_METRIC_STALE` (fail-closed).
**Dependencies:** MIG-0, RES-1.

## UPLOAD-1 — Upload path rework [migration-first]

**Scope:** `POST /worlds/:id/media` rework per §4.4 failure-atomicity table: validate → Phase-1 → temp write → fsync file → rename → fsync dir → INSERT `world_media_assets` (`roles='{}'`, `file_confirmed_present=true`) → commit; mimetype validation (magic bytes, 415 on invalid); backfill-freeze check (503 `BACKFILL_IN_PROGRESS`); maintenance-fence check under level-1; orphan compensation on row-insert failure (synchronous delete + 500).
**ADR sections:** §4.4, §4.1 (row creation, G3 new-file check), §4.7 (freeze), §4.3d (fence), §9.3.
**Acceptance criteria:**
- S8: failed metadata switch → orphan recovery path.
- S23: same bytes, different filenames → two rows, never merged.
- S24: failed replacement does not corrupt roles.
- Existing route (`src/modules/world/http/world.routes.ts:546-582`) behavior preserved for the pre-backfill grace period.
**Dependencies:** MIG-0, RES-1, QUOTA-1.

## DEL-1 — Asset deletion state machine T1/T2 [migration-first]

**Scope:** `DELETE /worlds/:id/media/:assetId` implementing §4.3b: T1 (locks → authoritative reference scan incl. §4.2 part-4 deletion-time verification → 409/503/`pending_deletion` durable boundary) + T2 (reacquire → re-verify → stat → unlink → `file_confirmed_present=false` → row delete → 204); idempotent retry on `pending_deletion`; 404 on already-deleted (success-equivalent); drift-conflict recording on discrepancy (409 + `snapshot_ref_drift` row).
**ADR sections:** §4.3b, §4.2 (scan contract + part 4), §4.3c (file-mutating lock class), §9.3.
**Acceptance criteria:**
- S3: deletion blocked with reference list (409 `ASSET_REFERENCED`).
- S4: unreferenced asset deleted synchronously, quota reclaimed.
- S7: attach of `pending_deletion` URL → 422 `ASSET_DELETED`.
- S9: crash recovery — file-without-row and row-without-file.
- S11: failed scan → 503, changes nothing.
- S35: inconclusive snapshot scan fails closed.
- S66: missing ref row, no re-verification yet → blocked at decision time via authoritative verification.
**Dependencies:** MIG-0. **Blocks:** DEL-2, API-1, DRIFT-1.

## DEL-2 — World deletion jobs T1–T5 + recovery [migration-first]

**Scope:** Draft-only world deletion per §4.9: T1 (publish check under world lock → shared-asset transfer → snapshot-protected transfer to unattributed → job row), T2 (mark `pending_deletion` + `referencing_worlds` cleanup), T3 (per-file unlink, enumerate-and-stat), T4 (row removal + ref-row cleanup + unattributed array_remove), T5 (world row delete, job cascades); crash recovery worker (level-0 session lock on dedicated connection, state-machine walk, counter rebuilt from ground truth); 409 `WORLD_HAS_PUBLISHED_VERSIONS`.
**ADR sections:** §4.9 (all), §4.3c (positions 0–8, R1–R7), §4.3d (per-transaction lock ownership).
**Acceptance criteria:**
- S10: blocked with published versions; resumable for draft-only.
- S16: concurrent publish vs deletion — one wins.
- S17: crash after unlink, before counter update → recovery enumerates.
- S29: crash around T4 — unattributed references preserved (operator fields untouched).
- S33: lock re-acquisition across the multi-transaction pass.
**Dependencies:** MIG-0, DEL-1.

## REF-1 — Reference validation contract [migration-first]

**Scope:** §4.2b transaction contract on every reference-setting path: scene metadata update, world metadata update, publish (snapshot creation), replacement T2 metadata switch. Locks-first-scan-second, `READ COMMITTED`, resolve URL → row, `lifecycle='active'`, `file_confirmed_present`, no active deletion job; 422 `ASSET_UNKNOWN`/`ASSET_DELETED`/`ASSET_FILE_MISSING`; 409 `WORLD_DELETION_IN_PROGRESS`; atomic `roles` add/remove with the URL write; backfill-freeze 503s.
**ADR sections:** §4.2b, §4.2 (canonical paths table), §4.7b (freeze).
**Acceptance criteria:**
- S13: invalid URLs rejected atomically.
- S18: cross-world URL → shared reference succeeds (no 422 `ASSET_WRONG_WORLD`).
- S28: metadata commit during deletion lock-wait seen by scan.
- S40: metadata change during backfill freeze → 503.
**Dependencies:** MIG-0. **Blocks:** SHARE-1, UPLOAD-1 (T2 switch).

## SHARE-1 — Shared assets, snapshot references, serving layer [migration-first]

**Scope:** `asset_snapshot_references` population (publish transaction + backfill, pinned SQL order §4.7 step 6, G3 scoping); `shared_with_worlds` add/remove/owner-eager-transfer; §4.5 registry-gated serving (`GET /media/{filename}`: registry → unattributed → 404; shared-asset authorization under context world's policy; drift-aware serving rules); F1/F2/F3 cascade replacements.
**ADR sections:** §4.1 (snapshot refs, G1–G3), §4.5, §4.7c(a–c) (shared contract), §4.7 step 6.
**Acceptance criteria:**
- S1: published version keeps old image after replacement.
- S2: detach from draft preserves published reference.
- S19: dual-role backfill + independent role replacement.
- S46: shared ownership lifecycle (all 17 steps incl. CHECK probes).
- S56: serving during unresolved `missing_row` drift.
- S58: NULL-world snapshot reference protected, servable, drift-repairable.
- S49: G3 — new-file collision aborts; transfers exempt.
- S50: backfill populates snapshot refs, no false drift.
**Dependencies:** MIG-0, REF-1, DEL-1.

## FENCE-1 — Maintenance fence [migration-first]

**Scope:** `is_maintenance_active()` fail-closed wrapper (single check path, no-narrowing); fence activation transaction (level-1 + atomic reservation invalidation → ABANDONED, rev 19–20 B8); 6-criterion release gate (level-1-holding release, rev 24); 503 `MAINTENANCE_MODE` wiring on all mutating paths; startup verification; new-writer checklist enforcement in review.
**ADR sections:** §4.3d (fence, activation, release, writer contract, mutation-path table, new-writer checklist), §5.5 (invalidation), §9.4 (startup).
**Acceptance criteria:**
- S55: every writer fenced; no direct SELECTs outside the wrapper.
- S59: fence activation invalidates in-flight Phase-2 uploads (≤1 chunk completes).
- S26: filesystem mutation exclusion under contention (Domain L).
- S14: global lock excludes reconciliation from file mutation.
- S48: competing-transaction lock-order tests (positions 0–9, R1–R7, Lemmas A–F).
**Dependencies:** MIG-0. **Blocks:** RECOV-1, OPS-1.

## RECOV-1 — Recovery authorization protocol [migration-first]

**Scope:** Establishment transaction (level-1 → fence recheck via wrapper → close-expired with `clock_timestamp()` → exclusivity guard → guarded INSERT); writer-exclusion verification procedure; per-transaction lifetime contract (BEGIN-gate + pre-COMMIT gate with `clock_timestamp()`, scope binding, `RECOVERY_SCOPE_DENIED`); scope permission mapping table (`repair` vs `restore-reconcile`); revocation (level-1-holding); release-criterion-2 integration.
**ADR sections:** §4.3d (recovery protocol steps 1–7), §9.2 step 9, §9.4 (repair entry requirement).
**Acceptance criteria:**
- S60: repair under active fence via authorization; failure keeps fence.
- S61: establishment concurrency, crash, expiry.
- S62: expiry mid-procedure boundary (real clock).
- S63: true-clock gate + revocation race.
- S64: close-expired on true clock after lock wait.
- S65: fence release mid-wait → clean abort, zero row changes.
- S67: wrong-scope operations denied.
- S20/S21/S25: single recovery worker; lock ordering; timeout behavior.
**Dependencies:** MIG-0, FENCE-1.

## BF-1 — Backfill runner + re-verification [migration-first]

**Scope:** Backfill job per §4.7: run-row lifecycle, write-freeze enforcement (actor checks), final inventory + manifest + `attribution_input_hash`, classification policy (mimetype via magic bytes, roles by URL, dual-role/single-file rules, never-merge-by-content), pinned SQL sequence (G2/G3 → registry → ref rows), executable reconciliation (both EXCEPT directions + conflict count + off-manifest diff), atomic completion transaction (level-1, hash recompute, complete/failed), rerun verify-never-skip + `backfill_conflicts` recording, single-active-run index handling (409 `BACKFILL_ALREADY_RUNNING`).
**ADR sections:** §4.7, §4.7b (freeze + hash + completion), §4.7c (re-verification algorithm, multi-world rules).
**Acceptance criteria:**
- S12: legacy file backfilled before enforcement.
- S30: interrupted backfill cannot enable enforcement.
- S31: rerun with changed metadata → conflict, not overwrite.
- S32: file added during freeze blocked, then caught.
- S36: file removed after freeze → data-loss outcome, not skip.
- S41: resolved conflict + later metadata change re-verifies.
- S44: completion race — no stale-input completion.
- S50: snapshot refs populated, no false drift.
- S54: attribution atomicity — unattributed→registry move as one level-1 transaction (R5: world row locked first).
**Dependencies:** MIG-0, OPS-0 (volume must exist). **Blocks:** DRIFT-1.

## DRIFT-1 — Drift-conflict resolution [migration-first]

**Scope:** Operator conflict-resolution transaction (§4.7c: lock conflict row → lock registry row → accept-recomputed / keep-existing → mark resolved, atomic); drift INSERT contract (§4.7c(d), §4.2 part 4); resolution reads (`subtype` branch, expected/actual sets as baseline, re-scan before INSERT/DELETE); unresolved-conflict blocking in deletion scans.
**ADR sections:** §4.7c(d), §4.2 part 4, §4.3c (freeze-serialized class 1→3→5→6).
**Acceptance criteria:**
- S46 steps 13–15, 17: drift (a/b/c) + CHECK probes.
- S66: deletion-time drift → 409 + conflict recorded.
**Dependencies:** BF-1, DEL-1.

## OPS-1 — Operational runbooks [docs + jobs]

**Scope:** (a) §9.2 restore runbook as operator docs + `diagnose`/`repair` CLI entry points (§9.4: read-only default, `--repair-media` flag, fence/authorization entry requirement, quarantine rules, `roles` recompute); (b) periodic capacity job (§5.5: metric computation, `unregistered_bytes` scan, staleness enforcement, `ACCOUNTING_DIVERGENCE` alerts, abandoned-temp cleanup via ABANDONED path); (c) `/health` media_storage exposure.
**ADR sections:** §9.2, §9.4, §5.5, §9.3.
**Acceptance criteria:**
- S22: published image restored from backup servable at original URL.
- S27: cutover rollback (with OPS-0).
- S42: out-of-band mutation detected and fenced.
- S47: restore fencing (external guarantee + fail-closed check).
- S26: contention exclusion (with FENCE-1).
- S39: file in both tables → `DUPLICATE_FILE_REGISTRATION` critical alert (single-owner invariant detection, §4.1/§5.5).
**Dependencies:** FENCE-1, RECOV-1, DEL-2.

## API-1 — API surface changes

**Scope:** `DELETE /worlds/:id/media/:assetId` (error contracts §4.3a table: 404/403/409/503/204 semantics); `POST /worlds/:id/media` response contract (201 + quota/capacity errors per §9.3 code-distinction rule); registry-gated serving changes in `GET /media/{filename}`; API reference docs updates.
**ADR sections:** §4.3a (endpoint error contracts), §4.5 (serving), §9.3 (status codes).
**Acceptance criteria:** S3, S4, S7 (endpoint behaviors); §9.3 code-distinction rule (`QUOTA_EXCEEDED` vs `STORAGE_FULL` vs `STORAGE_WRITE_FAILED` vs `STORAGE_METRIC_STALE` never conflated in monitoring).
**Dependencies:** UPLOAD-1, DEL-1, SHARE-1.

---

## Implementation order (recommended)

1. MIG-0 → 2. FENCE-1 → 3. RES-1 → 4. QUOTA-1 → 5. UPLOAD-1 + REF-1 (parallel) → 6. DEL-1 → 7. SHARE-1 + DEL-2 (parallel) → 8. RECOV-1 → 9. API-1 → 10. OPS-0 (parallel track, any time before 11) → 11. BF-1 → 12. DRIFT-1 → 13. OPS-1.

Rationale: fence and reservations are the load-bearing primitives every mutating path depends on; deletion before sharing (protection must exist before cross-world references multiply); recovery before backfill (restore runbook needs it); backfill last among code (needs volume + all writers frozen-correct).

## Per-slice verification standard

- Unit tests: pure logic (quota formula, scope mapping, state-machine transitions) — no Docker needed.
- Integration tests (Testcontainers or `TEST_DATABASE_URL`): every DB-touching slice — follow `tests/integration/` conventions (`SKIP_DB_TESTS` skip, per-run unique seeds per the 2026-10-13 lessons in `PROJECT_STATE.md`).
- Each slice's proving scenarios must be executable as tests where the ADR specifies deterministic behavior (S46, S48, S54, S55, S61–S67 are written as test procedures).
- Live UX Verification Gate (`AGENTS.md` §6) applies to API-1's user-facing changes after deploy.
- `CHANGELOG.md` + `PROJECT_STATE.md` updated per slice (per `AGENTS.md` §2).
