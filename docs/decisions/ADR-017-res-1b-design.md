# RES-1b Design: Phase-2 Writer Obligations

**Status:** DRAFT — pending ChatGPT design review. No implementation authorized.
**Date:** 2026-10-18.
**Scope:** Phase-2 writer obligations per ADR-017 §5.5 (rev 16–18). Does NOT include expiry-claim worker (RES-1c) or the registry handoff (QUOTA-1).
**Dependencies:** RES-1a (accepted). **Blocks:** RES-1c, QUOTA-1.

---

## 1. The Four Required Areas

### 1.1 Temporary Paths

**Deterministic path:** `/data/media/.tmp/{reservation_id}.part`

- The writer opens the path ONCE per upload with `O_CREAT | O_WRONLY | O_APPEND` and holds the file descriptor for the entire upload.
- One writer per reservation → one writer per path. No two writers can address the same temp file.
- The path is created by the writer (not the claim worker — `O_CREAT` is forbidden in the claim path per A17).
- On commit: the writer renames temp→final while holding `LOCK_SH`.
- On voluntary rollback: the writer unlinks after the `ROLLED_BACK` transition commits, while holding `LOCK_SH`.

**Temp-path identity invariant (A17):** For an active reservation, the path is NEVER unlinked, renamed, or replaced except by the owning writer's commit/rollback or the abandoned-temp cleanup job acting on an `ABANDONED` row.

### 1.2 Heartbeats

**Protocol:** Every 2 minutes while the upload is in flight:
```sql
UPDATE storage_reservations
   SET epoch = epoch + 1,
       expires_at = now() + interval '5 minutes',
       last_heartbeat_at = now()
 WHERE reservation_id = ? AND released_at IS NULL;
```

**Critical rules:**
- The heartbeat MUST increment `epoch`. A heartbeat without the increment is a correctness bug (the B1.2 claim CAS depends on it).
- If 0 rows are updated → the reservation is no longer active (claimed, committed, or rolled back) → the writer MUST abort immediately: stop writing, release the file lock, attempt temp-file cleanup (best-effort), return an error.
- Continuing to write after a 0-row heartbeat is a correctness bug.
- The heartbeat takes no file lock (DB-only). Races with the expiry claim are resolved by the claim's `WHERE epoch = $E1` compare-and-swap.

**What the heartbeat proves:** Liveness ("the writer process is alive and making progress"). It does NOT authorize writes by itself (see §3).

### 1.3 Fenced Writes

**Per-chunk protocol** (exact order, for EVERY chunk):
1. `flock(fd, LOCK_SH)` — shared lock on the temp file.
2. `SELECT state, released_at FROM storage_reservations WHERE reservation_id = ?` — re-validate under the lock.
3. If `state` not in (`RESERVED`, `WRITING`) or `released_at IS NOT NULL` → `flock(fd, LOCK_UN)`, close, abort. No bytes written.
4. `write(fd, chunk)` — the single in-flight syscall.
5. `flock(fd, LOCK_UN)` — release immediately.

**Normative rules:**
- Holding `LOCK_SH` across chunks is FORBIDDEN. It would block legitimate claims and pin capacity after a crash.
- The kernel releases the lock on process death — this is what lets the claim proceed for a dead writer.
- The lock makes "validate + write" atomic with respect to the expiry claim (which must hold `LOCK_EX` to finalize).

### 1.4 Safe-Open Behavior

**Writer side:** The writer creates the temp file with `O_CREAT` on first open. This is safe because:
- The path is deterministic per reservation_id (UUID).
- No other writer can address the same path (one writer per reservation).
- The claim worker NEVER uses `O_CREAT` (it only locks existing files).

**Claim side** (for reference; implemented in RES-1c): The worker MUST NOT use `O_CREAT`. It opens with `O_RDONLY`, verifies inode identity via `fstat` vs the pre-open stat, and aborts on mismatch.

### 1.5 Fenced Commit and Rollback

**Commit sequence** (while holding `LOCK_SH`):
1. `fsync` the temp file + directory.
2. BEGIN transaction.
3. Acquire L1, L2, L3 per the §4.3c lock order (file `LOCK_SH` → 1 → 3 → 6).
4. Rename temp→final path.
5. INSERT the asset row.
6. `UPDATE storage_reservations SET state='COMMITTED', released_at=now() WHERE reservation_id=? AND released_at IS NULL AND state IN ('RESERVED','WRITING')`.
7. Verify exactly 1 row affected. If 0 → ROLLBACK the entire transaction (including asset INSERT), abort.
8. COMMIT.
9. `flock(fd, LOCK_UN)` — AFTER commit completes.
10. Close fd.

**Lock-release ordering (normative, A18):** `LOCK_SH` is released AFTER the database transaction's COMMIT or ROLLBACK completes, on EVERY exit path:
- Normal commit: COMMIT → UNLOCK → close.
- 0-row abort: ROLLBACK → UNLOCK → close → abort.
- SQL error: ROLLBACK (in finally) → UNLOCK → close → propagate.
- Process death: kernel releases lock; DB rolls back on session end.

Releasing `LOCK_SH` before the transaction ends is a correctness bug.

---

## 2. The Fencing-Authority Race (Key Constraint)

**Constraint:** A heartbeat or lease alone must not authorize a write after its fencing authority has become invalid.

**The race:** Writer heartbeats at T0 (reservation active). Expiry claim finalizes at T1 (reservation → ABANDONED). Writer attempts chunk write at T2, relying on the T0 heartbeat. Without protection, bytes land post-abandonment.

**How the design closes it:**

The heartbeat is a *liveness signal*, not a *write authorization*. Every chunk write is authorized by a fresh validation performed **under `LOCK_SH`**, **immediately before** the `write()` syscall:

```
1. flock(LOCK_SH)                    ← acquire exclusion vs. claim
2. SELECT state ...                  ← fresh read, under the lock
3. IF not active → abort (no write)  ← authorization decision
4. write(chunk)                      ← authorized write
5. flock(LOCK_UN)                    ← release
```

**Why this works:**
- The expiry claim must hold `LOCK_EX` to finalize the `ABANDONED` transition.
- `LOCK_SH` (writer) and `LOCK_EX` (claim) are mutually exclusive.
- If the claim finalized before the writer's `flock(LOCK_SH)`, the writer's SELECT sees `ABANDONED` → aborts before `write()`.
- If the writer holds `LOCK_SH`, the claim's `LOCK_EX|LOCK_NB` fails → claim aborts for this cycle.
- The only window is a `write()` already in flight when the claim commits — bounded by a single chunk (B8 proof). Those bytes are conservatively counted in `abandoned_temp_bytes` via the row's `size_bytes`.

**What the heartbeat contributes:** It prevents the claim from finalizing against a *live* writer (the claim's epoch CAS fails if the writer heartbeated). But the heartbeat does NOT grant write permission — the per-chunk validation does.

**Failure mode if violated:** If an implementation skips the per-chunk validation and relies only on heartbeats, a claim can finalize between the last heartbeat and the write, causing post-abandonment bytes. This is the rev-15 gap that B1.2 was designed to close.

---

## 3. Invariants

1. **I1 (Reservation-write binding):** No byte is written to a temp path unless the writer holds `LOCK_SH` on that path AND has validated the reservation as active (state in `RESERVED`/`WRITING`, `released_at IS NULL`) under that lock, immediately before the `write()` syscall.

2. **I2 (Lock scope):** `LOCK_SH` is never held across chunk boundaries. It is acquired per-chunk and released immediately after the `write()`.

3. **I3 (Heartbeat integrity):** Every heartbeat increments `epoch`. A 0-row heartbeat update causes immediate abort.

4. **I4 (Commit atomicity):** The commit transaction (rename + asset INSERT + reservation→COMMITTED) is atomic. A 0-row reservation UPDATE causes full ROLLBACK including the asset row.

5. **I5 (Lock-release ordering):** `LOCK_SH` is released only after the enclosing DB transaction has committed or rolled back, on all exit paths.

6. **I6 (Temp-path exclusivity):** One writer per deterministic path. No two writers address the same temp file.

7. **I7 (No level-1 during chunks):** Phase-2 chunk writes never acquire the level-1 advisory lock. Domain R protection (reservation + flock) is sufficient and necessary to avoid multi-minute lock holds.

---

## 4. Failure Behavior

| Failure | Detection | Response | Accounting |
|---------|-----------|----------|------------|
| Heartbeat returns 0 rows | UPDATE rowcount | Abort immediately, unlock, cleanup temp (best-effort) | Reservation already terminal; no leak |
| Chunk validation sees non-active state | SELECT under LOCK_SH | Abort before write, unlock, close | No bytes written; reservation terminal |
| ENOSPC during write | `write()` returns ENOSPC | Attempt temp unlink; if unlink fails → single transaction: `UPDATE ... SET state='ABANDONED'` | Bytes in `abandoned_temp_bytes` via `size_bytes` (conservative) |
| Process crash mid-chunk | Kernel releases LOCK_SH; DB rolls back | Expiry claim (RES-1c) finalizes via CAS | `active_reservations_bytes` → `abandoned_temp_bytes` |
| Process crash holding LOCK_SH | Kernel releases on death | Claim proceeds next cycle | No lock leak |
| Fence activates mid-upload | Next heartbeat returns 0 rows (or validation sees ABANDONED) | Abort | B8: at most one in-flight chunk completes, counted conservatively |
| Commit transaction fails (0-row UPDATE) | Rowcount check | ROLLBACK entire transaction (including asset INSERT) | No orphan asset row; reservation terminal |
| SQL error during commit | Exception handler | ROLLBACK (finally) → UNLOCK → close → propagate | No partial commit |

---

## 5. Concurrency Cases

### 5.1 Stale worker (slow but alive)
A writer is slow (e.g., large file, slow network) but heartbeating. The expiry claim observes `epoch` advancing → skips the reservation. No interference. The per-chunk `LOCK_SH` is held only briefly, so claims are not starved.

### 5.2 Expired lease (crashed worker)
Writer crashes. Kernel releases `LOCK_SH`. Heartbeats stop. After `expires_at` + observation window, the claim worker: (1) verifies liveness evidence (epoch stale, mtime old), (2) acquires `LOCK_EX|LOCK_NB` (succeeds — no writer holds `LOCK_SH`), (3) finalizes `ABANDONED` via CAS. The temp file is cleaned up by the abandoned-temp job.

### 5.3 Maintenance-fence race
Fence activates while a writer is mid-upload. The writer's next heartbeat UPDATE returns 0 rows (the fence invalidation sets `released_at`), OR the per-chunk validation sees `ABANDONED`. The writer aborts. Per B8, at most one in-flight chunk completes; its bytes are counted in `abandoned_temp_bytes`.

### 5.4 Partial write (crash during chunk)
Writer crashes mid-`write()`. The partial chunk is in the temp file. The reservation remains active until the claim finalizes it. The abandoned-temp cleanup job unlinks the file. Accounting: `size_bytes` (reserved max) covers the partial bytes conservatively.

### 5.5 Cleanup failure (unlink fails)
Per S45: if the temp file cannot be unlinked (permissions, I/O error), the writer executes a single transaction setting `state='ABANDONED'`. The bytes are durably counted. A `TEMP_CLEANUP_FAILED` alert fires. The periodic job retries; the operator intervenes if persistent. Accounting is never dropped.

### 5.6 Two writers, different reservations (S53)
W1 and W2 write to different temp paths concurrently. Neither acquires level-1. Both use per-chunk `LOCK_SH` on their own paths. No interference — deterministic paths are unique. This is by design (Domain R).

### 5.7 Writer vs. claim on same path (S53)
Writer holds `LOCK_SH` mid-chunk. Claim attempts `LOCK_EX|LOCK_NB` → fails with `EWOULDBLOCK` → claim aborts for this cycle. No CAS UPDATE executes. The reservation stays active. The claim retries next cycle (≥60s).

---

## 6. Acceptance Tests

### 6.1 S45: ENOSPC + cleanup failure
- Setup: 10 MB available, 50 MB reservation.
- Write 10 MB, trigger ENOSPC, simulate unlink failure.
- Assert: single transaction sets `ABANDONED`; 507 `STORAGE_WRITE_FAILED`; bytes in `abandoned_temp_bytes`; `TEMP_CLEANUP_FAILED` alert.

### 6.2 S51: flock self-test
- On startup: verify `LOCK_EX|LOCK_NB` / `LOCK_SH|LOCK_NB` mutual exclusion works on the filesystem.
- If incoherent: refuse to start (or degraded mode with explicit operator ack).

### 6.3 S52: Fencing failures
- **Lock released before commit:** static check — no `LOCK_UN` while transaction open.
- **Wrong inode:** simulate path replacement between stat and open → claim aborts on inode mismatch.
- **Kill at boundaries:** kill -9 at each lock/transaction boundary → no leaked locks, no half-committed states.
- **Writer lock-release ordering:** instrument to verify UNLOCK happens after COMMIT/ROLLBACK on all paths.

### 6.4 S53: Domain-R exclusion
- Two concurrent writers on different paths: neither acquires level-1.
- Claim attempts during a chunk write: `LOCK_EX|LOCK_NB` fails → claim aborts.
- After chunk completes and heartbeat advances epoch: claim skips (writer alive).

### 6.5 Heartbeat protocol
- Heartbeat increments epoch; 0-row update → abort.
- Heartbeat without epoch increment is rejected (static check or test).

### 6.6 Per-chunk validation
- Write attempt after reservation claimed → validation sees non-active state → abort before `write()`.
- Verify no bytes are written when validation fails.

### 6.7 Fencing-authority race (new, per the key constraint)
- Setup: writer heartbeats, then claim finalizes (simulated).
- Writer attempts chunk write relying only on the (now-stale) heartbeat.
- Assert: per-chunk validation under `LOCK_SH` sees the terminal state → aborts BEFORE `write()`.
- Assert: zero bytes are written post-finalization.
- This test proves the heartbeat alone does not authorize writes.

---

## 7. Out of Scope (RES-1c, QUOTA-1)

- Expiry-claim worker implementation (candidate selection, CAS protocol, safe-open).
- Abandoned-temp cleanup job.
- Registry handoff (asset INSERT is part of the commit transaction, but the full QUOTA-1 integration is separate).
- The periodic capacity metric job.

---

## 8. Design Gate Checklist

- [x] Architecture.md reviewed (Phase-2 Domain R, lock ordering).
- [x] ADR-017 §5.5 rev 16–18 writer obligations incorporated.
- [x] A16 (hold lock through commit), A17 (safe-open, temp-path invariant), A18 (lock-release ordering) addressed.
- [x] B1.2 three obligations (heartbeat, fenced writes, abort discipline) specified.
- [x] B8 in-flight chunk bound acknowledged.
- [x] S45, S51, S52, S53 acceptance criteria mapped to tests.
- [x] Fencing-authority race constraint addressed (§2).
- [x] No implementation written; design-only.
