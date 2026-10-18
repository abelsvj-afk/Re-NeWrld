# RES-1c Design: Expiry Claim Worker

**Status:** DRAFT rev 1 — for review
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

### 2.1 Candidate selection

```sql
SELECT reservation_id, epoch, world_id, size_bytes
  FROM storage_reservations
 WHERE state IN ('RESERVED', 'WRITING')
   AND expires_at < now() - interval '30 seconds'  -- observation window
 ORDER BY expires_at
 LIMIT 100
 FOR UPDATE SKIP LOCKED;
```

**Observation window (30s):** `expires_at` is set to `now() + 5min` on each heartbeat. A heartbeat that is in-flight (UPDATE committed but our SELECT ran before it) could cause a false claim. The 30s buffer ensures we only claim reservations whose TTL expired at least 30s ago — well beyond any heartbeat commit latency. This is separate from the epoch CAS below, which is the hard correctness guard.

### 2.2 Per-candidate claim (exact order)

For each candidate:

1. **Read epoch:** `E1 = epoch` from the SELECT above.
2. **Acquire ownership lock:** `acquireExclusiveNonBlocking(lockPathFor(mediaRoot, reservation_id))`.
   - If `FlockError` (lock held) → a writer is alive → **skip** (release any partial state, move to next candidate).
   - The lockfile path is deterministic: `/data/media/.tmp/{reservation_id}.lock` (RES-1b §1.1).
3. **Compare-and-swap finalize** (single transaction):
   ```sql
   BEGIN;
   UPDATE storage_reservations
      SET state = 'ABANDONED',
          released_at = now(),
          claim_epoch = $E1,
          claim_finalized_at = now()
    WHERE reservation_id = $RID
      AND epoch = $E1
      AND released_at IS NULL
      AND state IN ('RESERVED', 'WRITING');
   -- Returns 0 or 1 rows.
   COMMIT;
   ```
   - If 0 rows → epoch advanced (heartbeat won the race) or state changed → **release lock, skip**. This is the B1.2 CAS — the hard guard against claiming a live writer.
   - If 1 row → claim finalized. Quota is released atomically (the `released_at IS NULL` → `NOT NULL` transition removes it from active accounting per migration 015 CHECK constraints).
4. **Temp file cleanup** (best-effort, while still holding the lock):
   - Unlink `/data/media/.tmp/{reservation_id}.part` if it exists (ignore ENOENT).
   - **Never unlink the `.lock` file** (RES-1b rev 4 invariant: lockfiles are permanent).
   - If unlink fails → log `TEMP_CLEANUP_FAILED`, leave for the abandoned-temp job (RES-1b §1.6e). The quota is already released; the file is orphaned but accounted.
5. **Release ownership lock.**

### 2.3 Why this is safe

| Threat | Mitigation |
|---|---|
| Writer is alive and heartbeating | Epoch CAS fails (heartbeat incremented epoch) → skip. |
| Writer is alive but heartbeat delayed | Ownership lock held by writer → `LOCK_EX\|LOCK_NB` fails → skip. |
| Writer crashed mid-chunk | Kernel released `LOCK_SH`; no heartbeat; lock acquirable; epoch stale → claim succeeds. |
| Heartbeat commits during claim | CAS on `epoch = $E1` fails → skip. The heartbeat's 0-row check is independent. |
| Two claim workers race | `FOR UPDATE SKIP LOCKED` on candidate selection; CAS is idempotent (second gets 0 rows). |
| Claim worker crashes after CAS but before unlink | Reservation is `ABANDONED` (quota freed). Temp file orphaned; abandoned-temp job cleans it. |

---

## 3. Scheduling

- **Interval:** Every 60 seconds (per RES-1b design §7: "claims run every 60s").
- **Runtime:** In-process interval in `server.ts`, alongside the delivery worker (RES-1b). Single-flight guard (skip tick if previous still running).
- **Batch size:** 100 candidates per tick (bounded work; `SKIP LOCKED` prevents head-of-line blocking).

---

## 4. Interaction with Fence (Maintenance Mode)

If the maintenance fence is active (`system_maintenance.active`):
- The claim worker **still runs**. Fence activation sets `released_at` on active reservations via `activateFence()` (RES-1a), which moves them out of the candidate set (`released_at IS NULL` filter).
- A reservation invalidated by the fence will have `state='ABANDONED'` (or fence-specific state) and `released_at NOT NULL` → not selected. No double-claim.

---

## 5. Observability

- **Counter:** `expiry_claims_total` (incremented per finalized claim).
- **Counter:** `expiry_claim_skips_total{reason="lock_held"|"epoch_advanced"|"not_expired"}`.
- **Log:** `info` per finalized claim with `reservation_id`, `world_id`, `size_bytes`, `claim_epoch`.
- **Log:** `warn` per temp-unlink failure with `reservation_id`.

---

## 6. Acceptance Tests

### 6.1 Crashed writer is claimed
- Setup: Create reservation, simulate writer (acquire ownership lock, write partial file), then kill writer (release lock, stop heartbeats). Advance `expires_at` to past.
- Assert: Claim worker finalizes `ABANDONED`, `released_at` set, `claim_epoch` matches, temp `.part` unlinked, `.lock` file still exists.

### 6.2 Live writer is NOT claimed
- Setup: Create reservation, start live writer (holds ownership lock, heartbeats every 2min).
- Assert: Claim worker skips (lock acquisition fails). Reservation remains `RESERVED`/`WRITING`.

### 6.3 Heartbeat race is safe
- Setup: Create reservation with expired `expires_at`. Start heartbeat loop in background. Run claim worker concurrently.
- Assert: Either the claim succeeds (heartbeat hadn't yet incremented) or the CAS fails (heartbeat won). In both cases, no corruption: if claimed, writer's next heartbeat gets 0 rows → aborts; if skipped, reservation stays active.

### 6.4 Epoch CAS prevents stale claim
- Setup: Create reservation, read `E1`, manually increment `epoch` (simulating heartbeat), then attempt claim with stale `E1`.
- Assert: CAS updates 0 rows → no state change.

### 6.5 Quota released atomically
- Setup: Create reservation for 10MB. Verify `sumActiveBytes` includes it. Run claim worker.
- Assert: After claim, `sumActiveBytes` excludes it. No window where bytes are double-counted or lost.

### 6.6 Observation window respected
- Setup: Create reservation with `expires_at = now() - 10s` (within 30s window).
- Assert: Claim worker does NOT select it this tick.

### 6.7 Temp cleanup failure does not block claim
- Setup: Create reservation, make temp file undeletable (chmod 000 on parent, or mock).
- Assert: Claim finalizes `ABANDONED` (quota freed). `TEMP_CLEANUP_FAILED` logged. File left for abandoned-temp job.

### 6.8 Fence-invalidated reservations are skipped
- Setup: Create reservation, activate fence (sets `released_at`).
- Assert: Claim worker does not select it (already released).

---

## 7. Out of Scope

- Abandoned-temp file retry (RES-1b §1.6e — separate job).
- Registry handoff QUOTA-1 (moves ABANDONED → CLEANED after audit window).
- Writer-side behavior (RES-1b).
- Production deployment, backfill, maintenance (not authorized).

---

## 8. Change Classification

**Level 2 (Feature)** — new background worker, no schema changes, no API changes. Uses existing `storage_reservations` table and RES-1b lock protocol.
