# RES-1b Design: Phase-2 Writer Obligations

**Status:** DRAFT rev 5 — pending ChatGPT design review. No implementation authorized.
**Date:** 2026-10-18.
**Scope:** Phase-2 writer obligations per ADR-017 §5.5 (rev 16–18). Does NOT include expiry-claim worker (RES-1c) or the registry handoff (QUOTA-1).
**Dependencies:** RES-1a (accepted). **Blocks:** RES-1c, QUOTA-1.

**Rev 5 changes:** (1) File identity via content digest (SHA-256) — EEXIST with different inode requires digest match; size/metadata alone insufficient. Fail closed if identity unprovable. (2) Startup recovery uses identical verification rules as normal publication — no shortcut to ACTIVE. (3) Explicit filesystem requirements: same-filesystem for temp/final, directory sync ordering, crash boundaries for link/unlink durability.

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
2. Finalize the content digest: the writer computes SHA-256 incrementally during chunk writes (§1.6b). Finalize the hash after the last chunk.
3. BEGIN transaction.
4. Acquire locks per §4.3c: file `LOCK_SH` → L1 → L2 → L3.
5. INSERT the asset row with `publication_status = 'PENDING'` and `content_sha256 = <digest>` (new columns; see schema note below).
6. `UPDATE storage_reservations SET state='COMMITTED', released_at=now() WHERE reservation_id=? AND released_at IS NULL AND state IN ('RESERVED','WRITING')`.
7. Verify exactly 1 row affected. If 0 → ROLLBACK entire transaction (including asset INSERT), release locks, abort. The temp file remains; the reservation is terminal.
8. COMMIT.

**Phase B — Filesystem publication (non-transactional, no-overwrite) (rev 4):**
8. `link(temp_path, final_path)` — hard link, NOT rename. `link()` fails with `EEXIST` if the destination exists; it never overwrites.
   - If `link()` succeeds → temp and final are now the same inode. Proceed to step 8b.
   - If `link()` fails with `EEXIST` → the destination already exists. Go to step 8a (verification).
   - If `link()` fails with ENOENT (temp gone) → check if final_path exists. If yes → go to step 8a. If no → log at error, mark asset as `PUBLICATION_FAILED`, alert.
   
   8a. **Destination verification (EEXIST case) (rev 5):** `stat(final_path)` → `(dev_f, ino_f)`. `stat(temp_path)` → `(dev_t, ino_t)` (may fail with ENOENT if temp was already unlinked).
       - If `(dev_f, ino_f) == (dev_t, ino_t)` → the link already succeeded (idempotent retry after crash). Identity proven by inode equality → proceed to step 8b.
       - Else → query the asset table: does an ACTIVE asset exist for this `final_path` with a different `reservation_id`? If yes → **COLLISION**: do NOT overwrite, do NOT modify. Log at error, mark this asset as `PUBLICATION_FAILED`, alert `PUBLICATION_COLLISION` with both reservation IDs. The existing file is untouched (verify via checksum before and after).
       - Else (no ACTIVE asset, different inode, temp may be gone) → **identity must be proven by content digest** (see §1.6b). Compute SHA-256 of `final_path`. Compare with the `content_sha256` recorded in the asset row (written during Phase A).
         - If digests match → the destination contains this reservation's bytes (recovered across restart) → proceed to step 8b.
         - If digests differ, or no digest was recorded → **fail closed**: do NOT activate, do NOT modify the destination. Mark asset as `PUBLICATION_IDENTITY_UNVERIFIED`, alert for manual reconciliation. The file remains untouched.
       - **Size matching is explicitly insufficient.** An unrelated file can have the same size. Reservation metadata alone does not prove the destination contains this reservation's bytes. Only inode equality or content-digest match establishes identity.
   
   8b. `unlink(temp_path)` — remove the temp directory entry. The file now exists only at `final_path`. (If `unlink` fails with ENOENT → another attempt already unlinked it → proceed; idempotent.)
9. `fsync` the destination directory.

**Why link() not rename():** `rename()` silently replaces an existing destination. If a previous publication attempt crashed after rename but before activation, a retry with `rename()` would overwrite the already-published file. `link()` + `unlink()` achieves the same effect (file appears at final path, temp entry removed) but fails safely if the destination exists. The verification step (8a) distinguishes idempotent retry from genuine collision.

### 1.6c Filesystem Requirements and Durability (rev 5)

**Same-filesystem requirement:**
- The temp directory (`/data/media/.tmp/`) and all final destination directories MUST reside on the same filesystem.
- `link()` fails with `EXDEV` if source and destination are on different filesystems. This is a hard requirement, not a fallback case.
- **Startup check:** On server startup, verify via `stat()` that `st_dev` is identical for the temp directory and the media root. If different → refuse to start with `FILESYSTEM_SPLIT` error. Log at critical.
- **Rationale:** Our deployment uses a single volume at `/data`, so this holds. The check prevents silent misconfiguration if the mount topology changes.

**Directory sync ordering (crash durability):**
The `link()` + `unlink()` sequence requires careful directory syncing for crash safety:
1. `link(temp_path, final_path)` — creates the directory entry.
2. `fsync(final_dir_fd)` — ensures the link is durable. **Critical:** without this, a crash could lose the link even though `link()` returned success.
3. `unlink(temp_path)` — removes the temp directory entry.
4. `fsync(temp_dir_fd)` — ensures the unlink is durable. **Required even if `temp_dir == final_dir`:** if they are the same directory, a single fsync after both operations suffices, but the code MUST handle the general case where they differ.
5. If `temp_dir == final_dir`: `fsync` once after step 3 covers both. The implementation MUST still issue the fsync (do not optimize it away based on path comparison — compare `st_dev`+`st_ino` of the directories, not path strings).

**Crash boundaries for link/unlink durability:**
| Crash point | Durable state | Recovery behavior |
|-------------|---------------|-------------------|
| After `link()` returns, before `fsync(final_dir)` | Link may or may not be durable | Recovery: check if final exists. If yes → verify identity → proceed. If no → retry link. Idempotent. |
| After `fsync(final_dir)`, before `unlink(temp)` | Link is durable; temp still exists | Recovery: temp and final are same inode → unlink temp → mark ACTIVE. |
| After `unlink(temp)` returns, before `fsync(temp_dir)` | Unlink may or may not be durable | Recovery: if temp reappears (unlink not durable), but final exists and is verified → unlink temp again → mark ACTIVE. Idempotent. |
| After `fsync(temp_dir)` | Both operations durable | Normal state: file at final only. Mark ACTIVE. |

**EXDEV handling:** If `link()` fails with `EXDEV` (different filesystems — should be prevented by startup check, but defense in depth):
- Log at critical with both paths and their `st_dev` values.
- Mark asset as `PUBLICATION_FAILED`, alert `FILESYSTEM_SPLIT`.
- Do NOT fall back to copy+unlink (copy is not atomic; it introduces new crash windows).
- The startup check should have caught this; EXDEV at runtime indicates a configuration change requiring operator intervention.

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
| Phase B (link+unlink) | Released | Held | Reservation is COMMITTED (terminal); no claim/cleanup acts on it. Ownership prevents writer conflict. link() never overwrites; EEXIST triggers verification. |
| Phase C (activation) | Released | Held | Same as Phase B. DB UPDATE is transactional. |
| Recovery | Not held | Must acquire | Recovery worker proves writer is dead via lock acquisition. |

**Schema requirement:** `world_media_assets` needs:
- `publication_status` (`PENDING`, `ACTIVE`, `PUBLICATION_FAILED`, `PUBLICATION_IDENTITY_UNVERIFIED`), default `PENDING`.
- `content_sha256` CHAR(64) (hex-encoded SHA-256), NULL allowed. Recorded in Phase A; used for identity verification in Phase B and recovery.
The serving layer MUST NOT serve assets with `publication_status != 'ACTIVE'`.

**Crash recovery (startup scan) (rev 5):**
Recovery MUST apply the same identity-verification rules as normal publication (§1.6b, Phase B step 8a). An existing file at the expected path is NOT sufficient to mark ACTIVE.

For each asset with `publication_status='PENDING'` (after acquiring the ownership lock per §1.6a):
- If temp exists and final does not → execute Phase B (link) + Phase C now. (Crash after Phase A, before Phase B.)
- If temp and final are the same inode → the link succeeded → `unlink(temp)` if needed → mark ACTIVE. (Crash during Phase B after link.)
- If final exists, temp gone, different inode (or temp never existed) → **verify identity via content digest** (§1.6b):
  - Compute SHA-256 of `final_path`, compare with recorded `content_sha256`.
  - If match → mark ACTIVE. (Crash after Phase B, before Phase C; temp already unlinked.)
  - If mismatch or no digest recorded → **fail closed**: do NOT mark ACTIVE, do NOT modify the file. Mark as `PUBLICATION_IDENTITY_UNVERIFIED`, alert for manual reconciliation.
- If neither path exists → the temp file was lost → mark `PUBLICATION_FAILED`, alert. The reservation is COMMITTED but the bytes are gone.

**Explicit prohibition:** Recovery MUST NOT mark an asset ACTIVE based solely on the existence of a file at `final_path`. The rev-4 shortcut ("if final exists → ACTIVE") is removed. Identity must be established by inode equality or digest match.

### 1.6b Content Digest Protocol (rev 5)

**Purpose:** Establish file identity across process restarts when inode comparison is impossible (temp file gone).

**Writer obligations:**
1. During chunk writes, the writer feeds each chunk into an incremental SHA-256 hasher.
2. After the final chunk (before Phase A), the writer finalizes the digest.
3. Phase A records `content_sha256` in the asset row alongside `publication_status='PENDING'`.

**Verification use:**
- In Phase B step 8a (EEXIST with different inode): compute SHA-256 of `final_path`, compare with the recorded digest. Match → identity proven. Mismatch → fail closed.
- In startup recovery: if temp is gone and final exists, compute digest and compare. Match → mark ACTIVE. Mismatch or no digest → fail closed, alert.

**Schema:** `world_media_assets.content_sha256 CHAR(64)` (hex-encoded), NULL allowed for backwards compatibility. If NULL (digest not recorded), recovery MUST fail closed — do not assume identity.

**Cost:** One SHA-256 pass over the file during recovery (only when needed). The writer's incremental hashing adds negligible overhead to chunk writes.

**Limitations:** SHA-256 is not a proof against malicious collision, but the threat model here is crash recovery, not adversarial tampering. For this purpose, it reliably distinguishes "this is our file" from "this is a different file."

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
| During Phase B (link) | Asset PENDING; reservation COMMITTED | Temp exists, or both temp+final (same inode), or final only | Startup scan: if link succeeded (same inode or final exists) → unlink temp if needed → mark ACTIVE; if EEXIST with different file → verify or fail safe |
| After Phase B, before Phase C | Asset PENDING; reservation COMMITTED | File at final path (temp unlinked) | Startup scan: final exists, temp gone → mark ACTIVE |
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

### 1.1b Ownership Lock Acquisition (rev 4)

**The inode problem (rev 3):** `flock` locks an inode, not a path. Unlinking a lockfile while the lock might be held allows a new inode at the same path with a conflicting lock. **Rev 4 solution:** Lockfiles are never unlinked during normal operations. The acquisition protocol establishes ownership on a stable inode.

**Acquisition protocol (inode-verified):**
1. Open P with `O_CREAT | O_RDWR` → fd. (`O_CREAT` is safe: if the file exists, we open the existing inode; if not, we create it. Nothing unlinks it during normal operations.)
2. `fstat(fd)` → record `(dev1, ino1)`.
3. `flock(fd, LOCK_EX | LOCK_NB)`. If `EWOULDBLOCK` → close fd, abort with `WRITER_CONFLICT`.
4. `stat(P)` → `(dev2, ino2)`. If `(dev1, ino1) != (dev2, ino2)` → the file was replaced (only possible via out-of-scope GC) → `flock(fd, LOCK_UN)`, close, retry from step 1 (max 3 attempts, then abort with `LOCKFILE_UNSTABLE`).
5. Success: we hold `LOCK_EX` on the stable inode for this reservation.

**Release protocol:**
1. `flock(fd, LOCK_UN)`.
2. Close fd.
3. Do NOT unlink P. The lockfile persists.

**Why this is safe:**
- The path→inode mapping is stable because nothing unlinks the lockfile during the reservation's active lifetime.
- If writer A holds the lock, writer B's non-blocking acquire fails → B aborts. No split-lock possible.
- If A crashes, the kernel releases the lock. B acquires it on the same inode. No stale state.

**Cleanup timing (rev 4):** The lockfile is NEVER unlinked during ordinary commit, rollback, recovery, or abandoned-temp cleanup. The kernel lock is released and the file descriptor is closed; the lockfile remains on disk. This eliminates the unlink/recreate race entirely — the path→inode mapping for a reservation's lockfile is stable for the lifetime of the reservation ID.

**Why permanent:** Unlinking a lockfile while holding its lock creates a window where a new process can create a new inode at the same path and acquire a lock on it, while the original holder still believes it owns the old inode. This split-lock condition is unfixable with unlink-based cleanup. Permanent lockfiles (0 bytes each) avoid the problem completely.

**Garbage collection (separate operation, not in RES-1b scope):**
Lockfiles accumulate (one 0-byte file per reservation). A future GC operation may remove them under these rules:
1. Only for reservations terminal (COMMITTED, ROLLED_BACK, ABANDONED) for > 7 days, or with no reservation row.
2. Acquire `LOCK_EX|LOCK_NB` with inode verification. If it fails → skip (in use).
3. If acquired → unlink the lockfile, release, close.
4. The 7-day grace period ensures no in-flight upload, recovery, or claim is still referencing the lock domain (uploads expire after 5 minutes; recovery runs at startup; claims run every 60s).

GC is explicitly out of scope for RES-1b implementation. The design notes it here for completeness.

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

### 6.11 Permanent lockfile verification (rev 4)
- **Setup:** Writer A acquires the ownership lock for reservation R1, completes the upload through Phase C, releases the lock.
- **Assert:** The lockfile `{R1}.lock` still exists on disk after commit. It was NOT unlinked.
- **Action:** Writer B (new reservation R2, different ID) acquires its own lockfile. Writer C attempts to acquire R1's lockfile (simulating a buggy retry).
- **Assert:** C's `LOCK_EX|LOCK_NB` on R1's lockfile succeeds (A released it). This is correct: R1's reservation is COMMITTED (terminal), so a new claim on its lock domain is harmless. The lockfile's persistence does not block legitimate operations.
- **No-unlink invariant:** Instrument all code paths (commit, rollback, recovery, abandoned-temp cleanup). Assert: no `unlink()` syscall is ever issued for a `*.lock` path during normal operations. (GC is out of scope.)
- **Split-lock prevention:** The permanent-lockfile rule eliminates the unlink/recreate race by construction. Document this as the rationale: the old approach (unlink while holding lock) allowed inode 200 to be locked while inode 100 was still held; permanent files make this impossible.

### 6.12 Lock lifecycle verification (new, rev 3)
- **Instrument:** Track `LOCK_SH` (data file) and ownership lock (`LOCK_EX` on lockfile) acquisition/release times relative to Phase A/B/C boundaries.
- **Assert:** `LOCK_SH` is released after Phase A COMMIT/ROLLBACK and before Phase B starts. It is never held during Phase B or Phase C.
- **Assert:** Ownership lock is held continuously from before the first chunk through Phase C completion.
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
- [x] Permanent lockfiles (rev 4) — never unlinked during normal ops; GC is separate with 7-day grace.
- [x] No-overwrite publication (rev 4) — link() not rename(); EEXIST triggers verification; collision fails safe.
- [x] Content-digest identity (rev 5, §1.6b) — SHA-256 recorded in Phase A; EEXIST with different inode requires digest match; size/metadata alone rejected.
- [x] Recovery verification parity (rev 5) — startup recovery uses identical identity checks as Phase B; no shortcut to ACTIVE.
- [x] Filesystem requirements (rev 5, §1.6c) — same-filesystem enforced at startup; directory sync ordering specified; crash boundaries for link/unlink durability.
- [x] No implementation written; design-only.

### 6.13 No-overwrite publication (new, rev 4)
- **Pre-existing destination (different bytes):** Setup: final_path already contains a file with different bytes (simulating a collision or stale file). Writer attempts Phase B `link(temp, final)`.
- **Assert:** `link()` fails with `EEXIST`. The writer does NOT overwrite. The verification step (8a) detects the inode mismatch and the absence of a matching asset row → marks `PUBLICATION_FAILED`, alerts `PUBLICATION_COLLISION`. The existing file is byte-identical before and after (verify via checksum).
- **Retry with correct file:** Setup: writer crashes after `link()` succeeds but before `unlink(temp)`. On recovery, temp and final are the same inode. Recovery worker re-runs Phase B.
- **Assert:** `link()` fails with `EEXIST`, but verification (8a) sees `(dev_f, ino_f) == (dev_t, ino_t)` → treats as idempotent success → unlinks temp → marks ACTIVE. No duplicate, no error.
- **Retry after full completion:** Setup: Phase B and C both completed (file at final, asset ACTIVE), but the writer crashes before releasing locks. Recovery worker scans and finds the asset is ACTIVE (not PENDING).
- **Assert:** Recovery skips (not PENDING). No re-link, no re-activation. Idempotent.
- **Collision with active asset:** Setup: an ACTIVE asset exists at final_path for reservation R1. A buggy writer for R2 attempts to publish to the same final_path.
- **Assert:** `link()` fails with `EEXIST`. Verification finds the ACTIVE asset row for R1 (different reservation_id) → fails safe, alerts. R1's file is untouched. R2's asset is marked `PUBLICATION_FAILED`.

### 6.14 Content-digest identity verification (new, rev 5)
- **Digest match:** Setup: PENDING asset with recorded SHA-256; temp file gone; final_path exists with different inode but matching digest. Recovery computes digest.
- **Assert:** Digests match → mark ACTIVE. The file is the correct one.
- **Digest mismatch:** Setup: final_path contains different bytes (different digest). 
- **Assert:** Digests differ → fail closed. Mark `PUBLICATION_IDENTITY_UNVERIFIED`, alert. Do NOT mark ACTIVE. Do NOT modify the file. Verify file checksum unchanged.
- **No digest recorded:** Setup: PENDING asset with NULL `content_sha256`; final_path exists.
- **Assert:** Fail closed. Mark `PUBLICATION_IDENTITY_UNVERIFIED`, alert. The absence of a digest is not proof of identity.
- **Size collision:** Setup: final_path contains a different file with the EXACT SAME SIZE as the expected file.
- **Assert:** Size match alone does NOT trigger ACTIVE. Digest verification runs and fails (different content) → fail closed. This proves size is insufficient.

### 6.15 Recovery verification parity (new, rev 5)
- **Setup:** For each crash boundary (after Phase A, after link, after unlink), run the startup recovery.
- **Assert:** Recovery applies the identical verification logic as Phase B step 8a. It does NOT take the shortcut "final exists → ACTIVE."
- **Assert:** In all cases where identity cannot be proven (no digest, digest mismatch, inode mismatch without digest), recovery marks `PUBLICATION_IDENTITY_UNVERIFIED` and alerts, rather than marking ACTIVE.
- **Parity test:** Run the same EEXIST scenario through both (a) normal Phase B and (b) startup recovery. Assert: both produce identical outcomes (ACTIVE on verified identity, fail-closed otherwise).

### 6.16 Filesystem durability (new, rev 5)
- **Same-filesystem check:** Setup: temp and final on different filesystems (simulate via bind mounts or test hook).
- **Assert:** Startup check detects `st_dev` mismatch → refuses to start with `FILESYSTEM_SPLIT`. Log at critical.
- **Crash after link, before fsync:** Kill after `link()` returns but before `fsync(final_dir)`. 
- **Assert:** Recovery checks final_path. If link was durable → verify identity → proceed. If not durable (final doesn't exist) → retry link. No data loss, no overwrite.
- **Crash after unlink, before fsync:** Kill after `unlink(temp)` returns but before `fsync(temp_dir)`.
- **Assert:** If temp reappears (unlink not durable), recovery sees both temp and final, verifies same inode (or digest), unlinks temp again → marks ACTIVE. Idempotent.
- **EXDEV at runtime:** Simulate `link()` returning EXDEV (despite startup check passing — e.g., remount).
- **Assert:** Log at critical, mark `PUBLICATION_FAILED`, alert `FILESYSTEM_SPLIT`. Do NOT fall back to copy. The file remains at temp; reservation is COMMITTED; operator must intervene.
- **Directory sync ordering:** Instrument to verify `fsync(final_dir)` is called after `link()` and before `unlink(temp)`, and `fsync(temp_dir)` is called after `unlink(temp)`. Assert the ordering is preserved on all paths.
