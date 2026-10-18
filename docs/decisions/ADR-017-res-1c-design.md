# RES-1c Design: Expiry Claim Worker

**Status:** DRAFT rev 3 — for review (addresses B2: typed lock-error contract)
**Scope:** Expiry-claim worker per ADR-017 §5.5. Does NOT include the Phase-2 writer (RES-1b), the registry handoff (QUOTA-1), or the abandoned-temp cleanup job (covered by RES-1b §1.6e).
**Depends on:** RES-1b (ownership lock protocol, `flock.ts`, deterministic temp paths). RES-1c is serial after RES-1b because the claim must acquire the writer-side ownership lock.

---

## 1. Purpose

Reservations are capacity holds with a 5-minute TTL, extended by writer heartbeats every 2 minutes (RES-1b §1.2). If a writer crashes or stalls, heartbeats stop and the reservation would pin quota forever. The expiry claim worker reaps these dead reservations:

1. Detects reservations with `expires_at < now()` and no recent heartbeat.
2. Verifies no writer is alive (ownership lock + epoch CAS).
3. Transitions `RESERVED`/`WRITING` → `ABANDONED`, releasing the quota hold atomically.
4. Cleans up the temp `.part` file (best-effort; the abandoned-temp job is the backstop).

---

## 2. Claim Protocol

### 2.1 Candidate discovery (separate transaction, commits immediately)

```sql
BEGIN;
SELECT reservation_id, epoch, world_id, size_bytes
  FROM storage_reservations
 WHERE state IN ('RESERVED', 'WRITING')
   AND expires_at < now() - interval '30 seconds'  -- operational buffer (§2.4)
 ORDER BY expires_at
 LIMIT 100;
COMMIT;  -- Releases all locks immediately. No row locks held during processing.
```

**B1 — Transaction boundaries (explicit):**
- Discovery runs in its own transaction which **commits before** per-candidate processing begins. No database locks are held while acquiring filesystem locks or performing I/O.
- `FOR UPDATE SKIP LOCKED` is **not used** for correctness. It is a contention-reduction hint only. The authoritative claim is the per-candidate conditional `UPDATE` in §2.2 step 3.
- **Concurrent workers:** Two workers may discover the same candidate. Both attempt the CAS. Exactly one gets 1 row; the other gets 0 rows and skips. The CAS (`WHERE epoch = $E1 AND released_at IS NULL`) is the single source of truth — not row locks, not `SKIP LOCKED`.
- **Heartbeat interaction:** A heartbeat (`UPDATE ... WHERE reservation_id=? AND released_at IS NULL`) does not block on our discovery (we hold no locks after COMMIT). If the heartbeat commits between our discovery and our CAS, the epoch will have advanced → our CAS gets 0 rows → we skip. If our CAS commits first, the heartbeat gets 0 rows → writer aborts (RES-1b §1.2). Either order is safe.

**Observation window (30s, operational buffer — not a correctness mechanism):** Reduces false claims from heartbeat commit latency. Per the review: the epoch CAS and ownership protocol must remain safe even if scheduling or DB latency exceeds 30s — and they do (§2.3).

### 2.2 Per-candidate claim (exact order, no database transaction open)

For each candidate (discovery transaction already committed):

1. **Read epoch:** `E1 = epoch` from the discovery SELECT.
2. **Acquire ownership lock:** `acquireExclusiveNonBlocking(lockPathFor(mediaRoot, reservation_id))`.
   - The lockfile path is deterministic: `/data/media/.tmp/{reservation_id}.lock` (RES-1b §1.1).
   - **B2 — Typed lock-error contract** (`src/shared/fs/flock.ts`):
     The helper exposes a typed error hierarchy. Callers match on the class, never on message text.
     ```typescript
     export class FlockError extends Error {}                    // base
     export class LockContentionError extends FlockError {}       // verified held by another process
     export class LockVerificationError extends FlockError {}     // /proc unavailable, stat failed, etc.
     export class LockSpawnError extends FlockError {}            // flock binary missing/failed
     export class LockTimeoutError extends FlockError {}          // blocking acquire timed out
     ```
     - `acquireExclusiveNonBlocking()` throws `LockContentionError` **only** when `flock -n` exits immediately (kernel-confirmed contention). This is not inferred — it is the kernel's own signal.
     - `LockVerificationError` → **fail closed**: log `error` with `reservation_id`, increment `expiry_claim_errors_total`, do NOT skip silently, do NOT claim. Candidate remains for next tick.
     - `LockSpawnError` → fail closed (deployment bug, not contention).
     - `LockTimeoutError` → only from blocking acquires; the claim uses non-blocking, so this indicates a bug if seen.
     - Worker handling:
     ```typescript
     try {
       lock = await acquireExclusiveNonBlocking(lockPath);
     } catch (err) {
       if (err instanceof LockContentionError) {
         // Confirmed: writer alive → skip candidate.
         metrics.expiry_claim_skips_total.inc({ reason: 'lock_held' });
         continue;
       }
       // All other lock errors: fail closed, operational alert.
       log('error', 'Expiry claim lock failure', { reservationId, error: err.message });
       metrics.expiry_claim_errors_total.inc();
       continue; // Do not claim; retry next tick.
     }
     ```
   - Rationale: Treating every `FlockError` as "writer alive" would silently protect reservations that are actually orphaned but unclaimable due to infrastructure failure.
3. **Compare-and-swap finalize** (single transaction, opened here, committed immediately):
   ```sql
   BEGIN;
   UPDATE storage_reservations
      SET state = 'ABANDONED',
          released_at = now(),
          claim_epoch = $E1,           -- migration 015 line 210 (BIGINT, nullable)
          claim_finalized_at = now()    -- migration 015 line 211 (TIMESTAMPTZ, nullable)
    WHERE reservation_id = $RID
      AND epoch = $E1
      AND released_at IS NULL
      AND state IN ('RESERVED', 'WRITING');
   -- Returns 0 or 1 rows.
   COMMIT;
   ```
   - **B5 — Schema verification:** `claim_epoch BIGINT` and `claim_finalized_at TIMESTAMPTZ` exist in `db/migrations/015_media_registry.sql` lines 210–211. The co-nullity CHECK (lines 225–227) requires both set together with `state='ABANDONED'` — our UPDATE satisfies this. No schema changes needed. Classification remains Level 2.
   - If 0 rows → epoch advanced (heartbeat won) or state changed → **release lock, skip**.
   - If 1 row → claim finalized. Quota released atomically: the `released_at IS NULL → NOT NULL` transition removes it from active accounting. The migration 015 CHECK constraint (`state IN ('ABANDONED',...) AND released_at IS NOT NULL`) makes this provable — a row cannot exist in a half-released state.
4. **Temp file cleanup** (best-effort, while still holding the lock):
   - Unlink `/data/media/.tmp/{reservation_id}.part` if it exists (ignore ENOENT).
   - **Never unlink the `.lock` file** (RES-1b rev 4 invariant: lockfiles are permanent).
   - If unlink fails → log `TEMP_CLEANUP_FAILED`, leave for the abandoned-temp job (RES-1b §1.6e). Quota already released; file orphaned but accounted.
5. **Release ownership lock** (via `releaseLock()`, waits for holder exit).

### 2.3 Why this is safe

**B3 — Lock identity (exact):**
- The writer holds the **ownership lock** (`LOCK_EX` on `/data/media/.tmp/{reservation_id}.lock`) for the entire session duration, from `openWriterSession` to `closeWriterSession` (RES-1b §1.1). This is the lock the expiry worker acquires with `LOCK_EX|LOCK_NB`.
- Separately, the writer holds a **per-chunk `LOCK_SH`** on the data file (`.part`) only during the validate+write of a single chunk, released immediately after (RES-1b §1.3). This is NOT the lock the claim acquires.
- **Crashed writer:** The kernel releases BOTH locks on process death. The ownership lock becomes acquirable. The per-chunk `LOCK_SH` is irrelevant after death (no process holds it).
- **Why the claim cannot strand a live writer:** After the claim finalizes `ABANDONED`, the worker holds the ownership lock. A live writer cannot be writing at this moment because:
  1. To write, it must hold the ownership lock (acquired at session open). We hold it → it cannot be in a write.
  2. Even if it held the lock earlier and we acquired it after release, the per-chunk validation (§1.3) re-checks `state IN ('RESERVED','WRITING')` under `LOCK_SH` before every chunk. After our CAS, state is `ABANDONED` → validation fails → `FENCED_WRITE_REJECTED`, no bytes written.
  3. The heartbeat (B4 below) is the backstop.

| Threat | Mitigation |
|---|---|
| Writer is alive and heartbeating | Epoch CAS fails → skip. |
| Writer is alive but heartbeat delayed | Ownership lock held → `LOCK_EX\|LOCK_NB` fails with confirmed contention → skip. |
| Writer crashed | Kernel released ownership lock; no heartbeat; epoch stale → claim succeeds. |
| Heartbeat commits during claim | CAS fails → skip. |
| Two claim workers race | CAS is idempotent (second gets 0 rows). `SKIP LOCKED` is contention-reduction only. |
| Claim worker crashes after CAS | `ABANDONED` (quota freed). Temp file orphaned; abandoned-temp job cleans it. |

---

## 3. Scheduling

- **Interval:** Every 60 seconds (per RES-1b design §7: "claims run every 60s").
- **Runtime:** In-process interval in `server.ts`, alongside the delivery worker (RES-1b). Single-flight guard (skip tick if previous still running).
- **Batch size:** 100 candidates per tick (bounded work; `SKIP LOCKED` prevents head-of-line blocking).

---

## 5. Interaction with Fence (Maintenance Mode)

**Correction from rev 1: `activateFence()` in `postgres-reserve-storage.adapter.ts` (lines 38–46) only sets `system_maintenance.active = true`. It does NOT modify `storage_reservations` rows.

- The claim worker **still runs** during fence.
- The candidate filter (`released_at IS NULL AND state IN ('RESERVED','WRITING')`) is correct as-is: fence does not change reservation rows, so no reservation is double-claimed or incorrectly skipped.
- Fence blocks **new admissions** (RES-1a checks `isFenceActive()` before L1). In-flight writers are not actively terminated by the fence in the current implementation — they continue until completion or expiry. Terminating in-flight writers on fence activation is out of scope for RES-1c.

---

## 6. Observability

- **Counter:** `expiry_claims_total` (incremented per finalized claim).
- **Counter:** `expiry_claim_skips_total{reason="lock_held"|"epoch_advanced"|"not_expired"}`.
- **Log:** `info` per finalized claim with `reservation_id`, `world_id`, `size_bytes`, `claim_epoch`.
- **Log:** `warn` per temp-unlink failure with `reservation_id`.

---

## 7. Acceptance Tests

### 7.1 Crashed writer is claimed
- Setup: Create reservation, simulate writer (acquire ownership lock, write partial file), then kill writer (release lock, stop heartbeats). Advance `expires_at` to past.
- Assert: Claim worker finalizes `ABANDONED`, `released_at` set, `claim_epoch` matches, temp `.part` unlinked, `.lock` file still exists.

### 7.2 Live writer is NOT claimed
- Setup: Create reservation, start live writer (holds ownership lock, heartbeats every 2min).
- Assert: Claim worker skips (lock acquisition fails). Reservation remains `RESERVED`/`WRITING`.

### 7.3 Heartbeat race is safe
- Setup: Create reservation with expired `expires_at`. Start heartbeat loop in background. Run claim worker concurrently.
- Assert: Either the claim succeeds (heartbeat hadn't yet incremented) or the CAS fails (heartbeat won). In both cases, no corruption: if claimed, writer's next heartbeat gets 0 rows → aborts; if skipped, reservation stays active.

### 7.4 Epoch CAS prevents stale claim
- Setup: Create reservation, read `E1`, manually increment `epoch` (simulating heartbeat), then attempt claim with stale `E1`.
- Assert: CAS updates 0 rows → no state change.

### 7.5 Quota released atomically
- Setup: Create reservation for 10MB. Verify `sumActiveBytes` includes it. Run claim worker.
- Assert: After claim, `sumActiveBytes` excludes it. No window where bytes are double-counted or lost.

### 7.6 Observation window respected
- Setup: Create reservation with `expires_at = now() - 10s` (within 30s window).
- Assert: Claim worker does NOT select it this tick.

### 7.7 Temp cleanup failure does not block claim
- Setup: Create reservation, make temp file undeletable (chmod 000 on parent, or mock).
- Assert: Claim finalizes `ABANDONED` (quota freed). `TEMP_CLEANUP_FAILED` logged. File left for abandoned-temp job.

### 7.8 Non-contention lock failure is NOT treated as "writer alive"
- Setup: Create reservation with expired TTL. Make the lockfile path unreadable (chmod 000 on `.tmp` dir) or simulate `/proc` unavailability.
- Assert: Claim worker logs `error` with `reservation_id`, increments `expiry_claim_errors_total`, does NOT mark the reservation as skipped-due-to-live-writer, does NOT finalize the claim. The reservation remains active for the next tick.

### 7.9 Writer cannot publish after invalidation
- Setup: Create reservation, simulate writer that has completed uploads but not yet published. Run claim worker to finalize `ABANDONED`.
- Assert: Writer's `phaseACommit()` rejects (reservation not committable). Writer's next heartbeat gets 0 rows → `HEARTBEAT_FAILED` → aborts. No asset row created, no bytes published.

### 7.10 Two claim workers concurrently
- Setup: Create 10 expired reservations. Start two claim worker instances simultaneously.
- Assert: Each reservation is finalized exactly once (10 `ABANDONED` rows, 10 distinct `claim_finalized_at`). No double-claim (second worker's CAS gets 0 rows). `expiry_claims_total` = 10.

### 7.11 Quota accounting under concurrency
- Setup: Create reservation for 10MB. Start a concurrent reader that polls `sumActiveBytes(world_id)` in a tight loop. Run claim worker.
- Assert: Every observed value is either includes-10MB (before CAS commit) or excludes-10MB (after CAS commit). No observation shows partial, negative, or double-counted bytes. The transition is atomic from the reader's perspective.

---

## 8. Out of Scope

- Abandoned-temp file retry (RES-1b §1.6e — separate job).
- Registry handoff QUOTA-1 (moves ABANDONED → CLEANED after audit window).
- Writer-side behavior (RES-1b).
- Production deployment, backfill, maintenance (not authorized).

---

## 9. Change Classification

**Level 2 (Feature)** — new background worker, no schema changes, no API changes. Uses existing `storage_reservations` table and RES-1b lock protocol.
