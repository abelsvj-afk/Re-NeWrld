# RES-1b Design: Phase-2 Writer Obligations

**Status:** DRAFT rev 3 — pending ChatGPT design review. No implementation authorized.
**Date:** 2026-10-18.
**Scope:** Phase-2 writer obligations per ADR-017 §5.5 (rev 16–18). Does NOT include expiry-claim worker (RES-1c) or the registry handoff (QUOTA-1).
**Dependencies:** RES-1a (accepted). **Blocks:** RES-1c, QUOTA-1.

**Rev 3 changes:** (1) Recovery workers must acquire the ownership lock before touching PENDING assets — prevents recovery/recovery and recovery/writer races. (2) Lockfile cleanup requires holding the lock + inode verification before unlink — closes the stale-inode ownership break. (3) Lock lifecycle clarified: LOCK_SH covers Phase A only; ownership lock covers all phases; I4 updated to the three-phase boundaries.

---

## 1. The Four Required Areas

### 1.1 Temporary Paths

**Deterministic path:** `/data/media/.tmp/{reservation_id}.part`

- The writer opens the path ONCE per upload with `O_CREAT | O_WRONLY | O_APPEND` and holds the file descriptor for the entire upload.
- The path is created by the writer (not the claim worker — `O_CREAT` is forbidden in the claim path per A17).
- On commit: the writer renames temp→final per the publication protocol (§1.6).
- On voluntary rollback: the writer unlinks after the `ROLLED_BACK` transition commits, while holding `LOCK_SH`.

**Temp-path identity invariant (A17):** For an active reservation, the path is NEVER unlinked, renamed, or replaced except by the owning writer's commit/rollback or the abandoned-temp cleanup job acting on an `ABANDONED` row.

### 1.1a Single-Writer Ownership (rev 2)

A unique path prevents *different* reservation IDs from colliding. It does NOT prevent two workers handling the *same* reservation ID from opening the same file concurrently. `O_APPEND` does not establish exclusive ownership.

**Ownership mechanism:** A dedicated lockfile at `/data/media/.tmp/{reservation_id}.lock`.

**Protocol:**
1. Before opening the temp data file, the writer opens (or creates) the lockfile with `O_CREAT | O_RDWR`.
2. The writer acquires `flock(lockfd, LOCK_EX | LOCK_NB)` — exclusive, non-blocking.
3. If the lock acquisition fails with `EWOULDBLOCK` → another writer owns this reservation → abort immediately with `WRITER_CONFLICT` (HTTP 409, not retryable by the same client without a new reservation). Do NOT open the data file. Do NOT write.
4. The writer holds the ownership lock for the ENTIRE upload (unlike the per-chunk `LOCK_SH` on the data file, which is released between chunks).
5. On normal completion: release the ownership lock AFTER the publication protocol completes (§1.6), then close.
6. On abort: release the ownership lock after cleanup, then close.
7. On process crash: the kernel releases the lock automatically. No stale ownership persists.

**Restarted worker rules:**
- A restarted worker MUST re-validate the reservation state (`SELECT state, released_at`) BEFORE attempting to acquire the ownership lock.
- If the reservation is not active → do NOT acquire the lock, do NOT open the data file. Return an error.
- If the reservation is active but the temp file was cleaned up (e.g., by the abandoned-temp job after a crash) → the worker may re-acquire ownership and re-create the temp file, resuming from byte 0. The `size_bytes` accounting remains conservative.
- A worker MUST NOT write to a temp file for a reservation that is not active, even if it holds a stale file descriptor.

**Why a separate lockfile (not the data file):**
- The data file uses per-chunk `LOCK_SH` (released between chunks to allow claims). Holding `LOCK_EX` on the data file for the whole upload would block legitimate expiry claims indefinitely.
- The lockfile is never written to, never renamed, never served. Its sole purpose is ownership.
- The lockfile is cleaned up with the temp file (on commit, rollback, or abandoned-temp cleanup).

**Invariant I6a:** At most one writer holds the ownership lock for a given reservation_id at any time. A writer that cannot acquire the ownership lock MUST NOT open, write to, or modify the temp data file.

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

**Critical correction (rev 2):** A filesystem rename cannot be rolled back by PostgreSQL. The commit sequence therefore does NOT include the rename in the database transaction. Instead, the database commits first (with the asset marked PENDING), then the rename executes, then the asset is marked ACTIVE. Crash recovery is driven by database state.

### 1.6 Crash-Safe Publication Protocol (rev 2)

**The problem:** `rename()` is not transactional. If we rename temp→final and then the DB transaction rolls back, the file sits at the final path with no asset row — an untracked published file. If we INSERT the asset and commit before the rename, there's a window where the DB references a file not yet at its final path.

**The protocol (ordered):**

**Phase A — Database commit (transactional):**
1. `fsync` the temp file and its directory.
2. BEGIN transaction.
3. Acquire locks per §4.3c: file `LOCK_SH` → L1 → L2 → L3.
4. INSERT the asset row with `publication_status = 'PENDING'` (new column; see schema note below).
5. `UPDATE storage_reservations SET state='COMMITTED', released_at=now() WHERE reservation_id=? AND released_at IS NULL AND state IN ('RESERVED','WRITING')`.
6. Verify exactly 1 row affected. If 0 → ROLLBACK entire transaction (including asset INSERT), release locks, abort. The temp file remains; the reservation is terminal.
7. COMMIT.

**Phase B — Filesystem publication (non-transactional, idempotent):**
8. `rename(temp_path, final_path)`.
   - If the rename fails with ENOENT (temp already gone) → check if final_path exists. If yes → another attempt already renamed it (idempotent retry) → proceed to step 9. If no → log at error, mark asset as `PUBLICATION_FAILED`, alert. The DB has a PENDING asset with no file — recoverable via re-upload.
9. `fsync` the destination directory.

**Phase C — Activation (transactional):**
10. BEGIN; `UPDATE world_media_assets SET publication_status='ACTIVE' WHERE asset_id=? AND publication_status='PENDING'`; COMMIT.
11. Release `LOCK_SH`. Release ownership lock. Close fds.

**Lock-release ordering (A18, rev 3 clarified):**

Two distinct locks with different lifetimes:

**`LOCK_SH` on the data file (per-chunk + Phase A):**
- Acquired per-chunk during writes; released immediately after each `write()`.
- Acquired for Phase A (the DB transaction); released AFTER Phase A commits or rolls back.
- NOT held during Phase B (rename) or Phase C (activation).
- **Why safe to release before Phase B/C:** After Phase A commits, the reservation is `COMMITTED` (terminal). The expiry claim only acts on active reservations (`RESERVED`/`WRITING`). The abandoned-temp cleanup only acts on `ABANDONED` rows. No background process will touch a COMMITTED reservation's files. Readers filter by `publication_status='ACTIVE'`, so the PENDING asset is invisible. The only remaining concurrency risk is another writer, which is excluded by the ownership lock (still held).

**Ownership lock on the lockfile (`LOCK_EX`):**
- Acquired before the first chunk (via inode-verified protocol).
- Held through ALL phases: chunk writes, Phase A, Phase B, Phase C.
- Released after Phase C completes (via cleanup protocol), or after rollback/abort cleanup.
- Released by the kernel on process crash.

**Which lock protects which phase:**
| Phase | LOCK_SH (data) | Ownership lock | Why |
|-------|----------------|----------------|-----|
| Chunk writes | Per-chunk hold | Held | LOCK_SH excludes claim's LOCK_EX; ownership excludes other writers |
| Phase A (DB txn) | Held through COMMIT/ROLLBACK | Held | LOCK_SH prevents claim finalizing mid-transaction; ownership prevents writer conflict |
| Phase B (rename) | Released | Held | Reservation is COMMITTED (terminal); no claim/cleanup acts on it. Ownership prevents writer conflict. Rename is atomic and idempotent. |
| Phase C (activation) | Released | Held | Same as Phase B. DB UPDATE is transactional. |
| Recovery | Not held | Must acquire | Recovery worker proves writer is dead via lock acquisition. |

**Schema requirement:** `world_media_assets` needs a `publication_status` column (`PENDING`, `ACTIVE`, `PUBLICATION_FAILED`), default `PENDING`. The serving layer MUST NOT serve assets with `publication_status != 'ACTIVE'`.

**Crash recovery (startup scan):**
For each asset with `publication_status='PENDING'`:
- If file exists at `final_path` → the rename completed → `UPDATE ... SET publication_status='ACTIVE'`. (Crash between Phase B and Phase C.)
- Else if file exists at `temp_path` → the rename did not complete → execute Phase B + C now. (Crash after Phase A commit, before Phase B.)
- Else (neither path exists) → the temp file was lost → `UPDATE ... SET publication_status='PUBLICATION_FAILED'`, alert. The reservation is COMMITTED but the bytes are gone. Operator intervention or re-upload required.

### 1.6a Recovery Ownership Protocol (rev 3)

**The problem:** The startup scan says "any worker finding a PENDING asset can rename or activate." But two recovery workers — or a recovery worker and the still-alive original writer — could race: both renaming, one activating while the other is still modifying the file, or acting on stale filesystem observations.

**The rule:** A recovery worker MUST acquire the ownership lock (via the inode-verified protocol in §1.1b) BEFORE performing any filesystem operation on a PENDING asset. Database-only observations (reading the PENDING row) do not require the lock, but any `rename`, `stat` used for a decision, or `unlink` does.

**Protocol:**
1. Recovery worker scans for `publication_status='PENDING'` assets.
2. For each PENDING asset, attempt to acquire the ownership lock for its `reservation_id` using the inode-verified protocol.
   - If `EWOULDBLOCK` → another worker (or the original writer) owns it → SKIP this asset this cycle. Do not touch its files. Do not update its row.
   - If acquired → this worker owns the recovery for this asset.
3. While holding the ownership lock, perform the filesystem checks and operations (stat temp/final, rename if needed).
4. Update the asset row (`ACTIVE` or `PUBLICATION_FAILED`).
5. Release the ownership lock (via the cleanup protocol if the lockfile should be removed, or just unlock if the reservation may still need it).

**Why this works:**
- **Recovery vs. original writer:** The original writer holds the ownership lock through all three phases (A, B, C). If the writer is still alive and working, the recovery worker's acquire fails → skips. The writer completes normally. No interference.
- **Recovery vs. crashed writer:** The kernel released the lock on crash. The recovery worker acquires it and proceeds. The original writer is dead; its file descriptors are closed.
- **Recovery vs. recovery:** Two workers scanning simultaneously → exactly one acquires the lock → the other skips. No double-rename, no conflicting updates.
- **Stale filesystem observations:** The lock guarantees no other party is modifying the files. The worker's `stat` results are valid for the duration of the lock hold.

**Lockfile existence:** If the lockfile was already cleaned up (unlinked), the recovery worker creates it with `O_CREAT` during acquisition. This is safe: if no lockfile exists, no one can be holding the ownership lock (they would have created it). The new lockfile establishes a fresh lock domain for the recovery.

**Crash boundaries and recovery:**

| Crash point | DB state | FS state | Recovery |
|-------------|----------|----------|----------|
| During Phase A (before COMMIT) | Transaction rolls back; no asset row; reservation still active | Temp file exists | Reservation remains active; writer (if alive) can retry; expiry claim handles if dead |
| After Phase A COMMIT, before Phase B | Asset PENDING; reservation COMMITTED | Temp file exists | Startup scan: temp exists → execute Phase B + C |
| During Phase B (rename) | Asset PENDING; reservation COMMITTED | Either temp or final (rename is atomic) | Startup scan: check both paths → complete or mark failed |
| After Phase B, before Phase C | Asset PENDING; reservation COMMITTED | File at final path | Startup scan: final exists → mark ACTIVE |
| After Phase C | Asset ACTIVE; reservation COMMITTED | File at final path | Normal state; no recovery needed |

**What this guarantees:**
- No file exists at a final path without a database row (the PENDING row is created before the rename).
- No PENDING asset is served to readers (serving layer filters).
- Every intermediate state is discoverable via the `publication_status` column.
- The rename is idempotent (safe to retry).
- No byte is uncounted (the reservation's `size_bytes` covers the temp file until COMMITTED; the asset row covers it after).

**Voluntary rollback (unchanged):**
1. While holding `LOCK_SH` and the ownership lock: BEGIN.
2. `UPDATE storage_reservations SET state='ROLLED_BACK', released_at=now() WHERE reservation_id=? AND released_at IS NULL`.
3. COMMIT.
4. Unlink the temp file (best-effort; if it fails, the abandoned-temp job will clean it up).
5. Release locks, close fds.

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

4. **I4 (Commit phases):** Publication proceeds in three ordered phases: (A) Database transaction commits the asset row as PENDING and the reservation as COMMITTED atomically; (B) Filesystem rename moves temp→final (idempotent, atomic); (C) Database transaction marks the asset ACTIVE. A 0-row reservation UPDATE in Phase A causes full ROLLBACK of Phase A (including the asset INSERT). Phases B and C are idempotent and recoverable via the startup scan. No single transaction spans the DB and filesystem.

5. **I5 (Lock-release ordering):** `LOCK_SH` is released only after the enclosing DB transaction has committed or rolled back, on all exit paths.

6. **I6 (Temp-path exclusivity):** One writer per deterministic path. No two writers address the same temp file.

6a. **I6a (Single-writer ownership):** At most one writer holds the ownership lock (`{reservation_id}.lock`, `LOCK_EX|LOCK_NB`) for a given reservation at any time. A writer that cannot acquire the ownership lock MUST NOT open, write to, or modify the temp data file. The lock is held for the entire upload and released by the kernel on crash.

### 1.1b Ownership Lock Acquisition and Cleanup (rev 3)

**The inode problem:** `flock` locks an inode, not a path. If process A holds `LOCK_EX` on inode 100 (path P), and process B unlinks P and creates a new file at P (inode 200), process C can acquire `LOCK_EX` on inode 200. A and C both believe they own the reservation. Unlinking a lockfile while the lock might be held breaks the ownership guarantee.

**Acquisition protocol (inode-verified):**
1. Open P with `O_CREAT | O_RDWR` → fd.
2. `fstat(fd)` → record `(dev1, ino1)`.
3. `flock(fd, LOCK_EX | LOCK_NB)`. If `EWOULDBLOCK` → close fd, abort with `WRITER_CONFLICT`.
4. `stat(P)` → if ENOENT → someone unlinked it → `flock(fd, LOCK_UN)`, close, abort/retry.
5. `stat(P)` → `(dev2, ino2)`. If `(dev1, ino1) != (dev2, ino2)` → the file was replaced → `flock(fd, LOCK_UN)`, close, retry from step 1 (max 3 attempts, then abort with `LOCKFILE_UNSTABLE`).
6. Success: we hold `LOCK_EX` on the inode that P currently resolves to.

**Cleanup protocol (proving the lock is free):**
The lockfile MUST NOT be unlinked unless the cleaning process holds the ownership lock.
1. Open P (without `O_CREAT` — if ENOENT, nothing to clean).
2. Attempt `flock(fd, LOCK_EX | LOCK_NB)` with inode verification (steps 2–5 above).
   - If `EWOULDBLOCK` → an owner is active → ABORT cleanup for this reservation. Do NOT unlink.
   - If inode verification fails → retry or abort.
3. We now hold the lock. No other process can believe it owns the reservation (any other holder would have blocked our acquisition; any stale fd refers to an inode we now own).
4. Unlink P.
5. `flock(fd, LOCK_UN)`, close fd.

**Why this is safe:**
- If writer A holds the lock, cleanup B's non-blocking acquire fails → B does not unlink. The path→inode mapping remains stable.
- If A crashed, the kernel released the lock. B acquires it, verifies the inode, unlinks. Any stale fd held by a dead process is irrelevant.
- The race "A opens but hasn't locked yet when B unlinks" is closed by B's lock acquisition: B can only unlink after acquiring the lock. If A hasn't locked yet, B gets the lock first. A then fails its `LOCK_EX|LOCK_NB` (B holds it) or fails inode verification (B unlinked). Either way, A does not proceed.

**Cleanup timing:** The lockfile is unlinked only after (a) successful publication (Phase C complete), (b) voluntary rollback committed, or (c) abandoned-temp cleanup of an ABANDONED row — and in all cases only via the cleanup protocol above.

7. **I7 (No level-1 during chunks):** Phase-2 chunk writes never acquire the level-1 advisory lock. Domain R protection (reservation + flock) is sufficient and necessary to avoid multi-minute lock holds.

8. **I8 (Publication atomicity):** No file exists at a final (published) path without a corresponding asset database row. The asset row (as PENDING) is committed before the rename executes. Readers never see PENDING assets.

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

### 6.8 Crash-safe publication (new, rev 2)
- **Crash after Phase A COMMIT, before Phase B:** Kill the writer after the DB transaction commits but before the rename. Assert: asset row exists with `PENDING`, reservation is `COMMITTED`, temp file exists. Restart → startup scan finds PENDING asset with temp file → completes rename → marks ACTIVE. Assert: file at final path, asset ACTIVE, no orphan.
- **Crash during Phase B (rename):** Kill mid-rename (or simulate by manually placing file at final path with PENDING asset). Assert: startup scan detects file at final path → marks ACTIVE without re-renaming.
- **Crash after Phase B, before Phase C:** File at final path, asset PENDING. Assert: startup scan marks ACTIVE. Assert: no duplicate file, no re-rename.
- **Temp lost:** PENDING asset with neither temp nor final file exists. Assert: marked `PUBLICATION_FAILED`, alert fires, no silent data loss.
- **Reader isolation:** During the PENDING window (after Phase A, before Phase C), assert that the serving layer does not return the asset (filtered by `publication_status`).

### 6.9 Single-writer ownership (new, rev 2)
- **Race to acquire:** Two writers attempt to open the same reservation_id concurrently. Assert: exactly one acquires the ownership lock (`LOCK_EX|LOCK_NB`); the other gets `EWOULDBLOCK` → aborts with `WRITER_CONFLICT` without opening the data file or writing any bytes.
- **Crash releases ownership:** Writer acquires ownership lock, then crashes (kill -9). Assert: kernel releases the lock. A new writer can acquire ownership for the same reservation (after validating the reservation is still active).
- **Stale worker:** Writer holds ownership lock; reservation is claimed (ABANDONED) by the expiry worker. A restarted worker validates state → sees ABANDONED → does NOT acquire the lock, does NOT write. Assert: no bytes written to the abandoned temp file.
- **Lockfile cleanup:** After successful commit, assert the `.lock` file is removed along with the temp file. After abandoned-temp cleanup, assert the `.lock` file is also removed.

### 6.10 Concurrent recovery (new, rev 3)
- **Setup:** Create a PENDING asset (simulate crash after Phase A). Start two recovery workers simultaneously.
- **Assert:** Exactly one worker acquires the ownership lock; the other skips the asset (no filesystem operations, no row updates).
- **Assert:** The asset is renamed (if needed) and marked ACTIVE exactly once. No double-rename, no conflicting updates.
- **Recovery vs. live writer:** Start a writer (holding ownership lock, in Phase B). Start a recovery worker. Assert: recovery worker fails to acquire the lock → skips the asset. Writer completes normally. No interference.

### 6.11 Lockfile cleanup race (new, rev 3)
- **Setup:** Writer A holds the ownership lock (inode 100). Cleanup process B attempts to unlink the lockfile.
- **Assert:** B's `LOCK_EX|LOCK_NB` fails with `EWOULDBLOCK` → B aborts cleanup, does NOT unlink. The path→inode mapping remains stable.
- **Action:** Kill writer A (kernel releases lock). B retries.
- **Assert:** B acquires the lock, verifies inode identity, unlinks the path, releases. 
- **Race variant:** Writer C opens the lockfile path but hasn't acquired the lock yet when B unlinks (after acquiring it). Assert: C's subsequent `LOCK_EX|LOCK_NB` fails (B holds it) OR C's inode verification fails (path unlinked) → C does not proceed as owner.
- **Stale inode:** Simulate the inode-replacement attack (unlink + create new file at same path while A holds lock on old inode). Assert: A's inode verification on next acquisition attempt fails → A does not proceed with a stale lock.

### 6.12 Lock lifecycle verification (new, rev 3)
- **Instrument:** Track `LOCK_SH` (data file) and ownership lock (`LOCK_EX` on lockfile) acquisition/release times relative to Phase A/B/C boundaries.
- **Assert:** `LOCK_SH` is released after Phase A COMMIT/ROLLBACK and before Phase B starts. It is never held during Phase B or Phase C.
- **Assert:** Ownership lock is held continuously from before the first chunk through Phase C completion.
- **Assert:** During Phase B and C (when `LOCK_SH` is released), no expiry claim or cleanup operation modifies the reservation's files (verified by attempting claims/cleanups and asserting they skip COMMITTED reservations).
- **Kill at boundary:** Kill the writer between Phase A COMMIT and Phase B. Assert: startup scan recovers via the ownership lock protocol; no `LOCK_SH` is leaked (it was already released); the ownership lock was released by the kernel.

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
- [x] Crash-safe publication protocol defined (rev 2, §1.6) — rename not in DB transaction; PENDING/ACTIVE with DB-driven recovery.
- [x] Single-writer ownership mechanism defined (rev 2, §1.1a) — dedicated lockfile, kernel release on crash, restarted-worker rules.
- [x] Recovery ownership protocol defined (rev 3, §1.6a) — recovery workers must acquire ownership lock; prevents recovery/recovery and recovery/writer races.
- [x] Lockfile cleanup inode safety defined (rev 3, §1.1b) — unlink only while holding the lock + inode verification.
- [x] Lock lifecycle clarified (rev 3) — LOCK_SH covers Phase A only; ownership lock covers all phases; I4 updated to three-phase boundaries.
- [x] No implementation written; design-only.
