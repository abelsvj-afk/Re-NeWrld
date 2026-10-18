# RES-1b Design: Phase-2 Writer Obligations

**Status:** DRAFT rev 27 — pending ChatGPT design review. No implementation authorized.
**Date:** 2026-10-18.
**Scope:** Phase-2 writer obligations per ADR-017 §5.5 (rev 16–18). Does NOT include expiry-claim worker (RES-1c) or the registry handoff (QUOTA-1).
**Dependencies:** RES-1a (accepted). **Blocks:** RES-1c, QUOTA-1.

**Rev 6 changes:** (1) Authoritative durability order: link → fsync(final_dir) → unlink → fsync(temp_dir); no exceptions. (2) Nested mount detection: startup scans for mounts under media root; per-publication st_dev check on actual destination. (3) Stale tests updated: link/unlink terminology, digest verification, permanent lockfiles.

---

## 1. The Four Required Areas

### 1.1 Temporary Paths

**Deterministic path:** `/data/media/.tmp/{reservation_id}.part`

- The writer opens the path ONCE per upload with `O_CREAT | O_WRONLY | O_APPEND` and holds the file descriptor for the entire upload.
- The path is created by the writer (not the claim worker — `O_CREAT` is forbidden in the claim path per A17).
- On commit: the writer links temp→final per the publication protocol (§1.6).
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
- The lockfile persists permanently (rev 4). It is never unlinked during commit, rollback, or abandoned-temp cleanup — only the kernel lock is released.

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

**Critical correction (rev 2):** A filesystem rename cannot be rolled back by PostgreSQL. The commit sequence therefore does NOT include the rename in the database transaction. Instead, the database commits first (with the asset marked PENDING), then the link executes, then the asset is marked ACTIVE. Crash recovery is driven by database state.

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
   
   8b. `fsync(final_dir_fd)` — **MUST complete before step 8c.** This makes the link durable. Removing the temp entry before the final entry is durably recorded could lose the file on crash.
   8c. `unlink(temp_path)` — remove the temp directory entry. The file now exists only at `final_path`. (If `unlink` fails with ENOENT → another attempt already unlinked it → proceed; idempotent.)
   8d. `fsync(temp_dir_fd)` — ensures the unlink is durable. **Always issued**, even if `temp_dir` and `final_dir` are the same directory (compare by `st_dev`+`st_ino`, not path strings). No "single fsync suffices" exception: the link must be durable (8b) before the temp entry is removed (8c).

**Why link() not rename():** `rename()` silently replaces an existing destination. If a previous publication attempt crashed after rename but before activation, a retry with `rename()` would overwrite the already-published file. `link()` + `unlink()` achieves the same effect (file appears at final path, temp entry removed) but fails safely if the destination exists. The verification step (8a) distinguishes idempotent retry from genuine collision.

### 1.6c Filesystem Requirements and Durability (rev 5)

**Same-filesystem requirement:**
- The temp directory (`/data/media/.tmp/`) and all final destination directories MUST reside on the same filesystem.
- `link()` fails with `EXDEV` if source and destination are on different filesystems. This is a hard requirement, not a fallback case.
- **Startup check (two parts):**
  1. **Nested mount detection:** Scan `/proc/mounts` (or equivalent) for any mount points under the media root (`/data/media/`). If any nested mount exists → refuse to start with `NESTED_MOUNT_DETECTED` error. Log at critical with the mount path. Rationale: a nested mount could place a destination directory on a different filesystem even if the media root matches the temp directory.
  2. **Device verification:** Verify via `stat()` that `st_dev` is identical for the temp directory and the media root. If different → refuse to start with `FILESYSTEM_SPLIT` error. Log at critical.
- **Per-publication check (defense in depth):** In Phase B, before `link()`, `stat()` the actual destination directory and compare its `st_dev` with the temp directory's `st_dev`. If different → abort publication, mark `PUBLICATION_FAILED`, alert `FILESYSTEM_SPLIT`. This catches a mount change that occurred after startup.
- **Rationale:** Our deployment uses a single volume at `/data`, so this holds. The checks prevent silent misconfiguration if the mount topology changes.
- **Runtime EXDEV:** Retained regardless. If `link()` returns EXDEV despite the checks → log at critical, mark `PUBLICATION_FAILED`, alert. Do NOT fall back to copy.

**Directory sync ordering (crash durability) — AUTHORITATIVE:**
The `link()` + `unlink()` sequence has exactly one valid order. No exceptions, no optimizations:
1. `link(temp_path, final_path)` — creates the directory entry.
2. `fsync(final_dir_fd)` — ensures the link is durable. **MUST complete before step 3.** Without this, a crash could lose the final entry after the temp entry is removed.
3. `unlink(temp_path)` — removes the temp directory entry. **MUST NOT execute before step 2 completes.**
4. `fsync(temp_dir_fd)` — ensures the unlink is durable. **Always issued.** If `temp_dir` and `final_dir` are the same directory (verified by `st_dev`+`st_ino`, not path strings), this is a second fsync on the same fd — still required, not optional.

**Rationale for no exceptions:** The "single fsync after both operations" optimization is UNSAFE. If we do link → unlink → fsync (once), a crash after unlink but before fsync loses both the link and the unlink — the file may exist at neither path durably. The authoritative order guarantees: after step 2, the file is durably at `final_path` regardless of what happens next.

**Crash boundaries for link/unlink durability:**
| Crash point | Durable state | Recovery behavior |
|-------------|---------------|-------------------|
| After `link()` returns, before `fsync(final_dir)` | Link may or may not be durable | Recovery: check if final exists. If yes → verify identity (inode/digest) → `fsync(final_dir_fd)` MUST succeed → unlink temp → `fsync(temp_dir_fd)` → mark ACTIVE. If fsync fails → stay PENDING, alert. If no final → retry link. |
| After `fsync(final_dir)`, before `unlink(temp)` | Link is durable; temp still exists | Recovery: temp and final are same inode → re-issue `fsync(final_dir)` (confirm) → unlink temp → `fsync(temp_dir)` → mark ACTIVE. |
| After `unlink(temp)` returns, before `fsync(temp_dir)` | Unlink may or may not be durable | Recovery: verify final identity → `fsync(final_dir_fd)` MUST succeed (confirm durability) → if temp reappears, unlink again → `fsync(temp_dir_fd)` → mark ACTIVE. If `fsync(final_dir)` fails → stay PENDING, alert. If `fsync(temp_dir)` fails (final durable) → mark ACTIVE, log warning, retry cleanup per §1.6d. |
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
- NOT held during Phase B (link+unlink) or Phase C (activation).
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
- If temp and final are the same inode → the link succeeded → **execute §1.6d steps 4–7**: `fsync(final_dir_fd)` MUST succeed before `unlink(temp)`; then `fsync(temp_dir_fd)`; then mark ACTIVE. (Crash during Phase B after link.) Identity is proven by inode equality, but durability must still be confirmed via fsync.
- If final exists, temp gone, different inode (or temp never existed) → **verify identity via content digest** (§1.6b), then **execute §1.6d durability**:
  - Compute SHA-256 of `final_path`, compare with recorded `content_sha256`.
  - If match → identity proven → **issue `fsync(final_dir_fd)` and confirm success** (§1.6d step 4) → then mark ACTIVE. (Crash after Phase B, before Phase C; temp already unlinked.) The fsync is required even though there is no temp entry to remove — it confirms the final link is durable before activation.
  - If fsync fails → do NOT mark ACTIVE. Preserve state, alert `FSYNC_FAILED`. Retry next cycle.
  - If digest mismatch or no digest recorded → **fail closed**: do NOT mark ACTIVE, do NOT modify the file. Mark as `PUBLICATION_IDENTITY_UNVERIFIED`, alert for manual reconciliation.
- If neither path exists → the temp file was lost → mark `PUBLICATION_FAILED`, alert. The reservation is COMMITTED but the bytes are gone.

**Explicit prohibition:** Recovery MUST NOT mark an asset ACTIVE based solely on the existence of a file at `final_path`. The rev-4 shortcut ("if final exists → ACTIVE") is removed. Identity must be established by inode equality or digest match.

### 1.6d Recovery Durability Ordering (rev 7)

**Critical:** Recovery must follow the same durability ordering as the original writer (§1.6c). An inode match proves *identity*, not *durability*. The final link must be fsynced before the temp entry is removed, even in recovery.

**Recovery Phase B (authoritative):**
1. Acquire ownership lock (§1.6a).
2. Determine the state (per the crash-recovery table above).
3. If link needed: `link(temp_path, final_path)`.
   - On EEXIST → verify identity (inode or digest) per step 8a.
4. `fsync(final_dir_fd)` — **MUST complete before step 5.** If the link was already durable from a previous attempt, this fsync is still issued (idempotent, ensures durability).
5. `unlink(temp_path)` — **MUST NOT execute before step 4 completes.** (If ENOENT → already unlinked → proceed.)
6. `fsync(temp_dir_fd)` — always issued.
7. Mark ACTIVE (Phase C).

**The §6.8 crash-after-link case corrected:** When recovery finds that `link()` already succeeded (same inode) but `fsync(final_dir)` was not confirmed, recovery MUST issue `fsync(final_dir)` and wait for its successful return BEFORE unlinking temp. It must NOT unlink based on identity alone.

**fsync failure behavior (both directory syncs):**
- If `fsync(final_dir_fd)` fails → **do NOT proceed to unlink.** The link's durability is unconfirmed. Preserve the temp entry. Leave the asset as PENDING. Log at error with the errno, alert `FSYNC_FAILED`. The asset remains unavailable; retry on next recovery cycle or operator intervention. **A failed fsync must never be treated as successful publication.**
- If `fsync(temp_dir_fd)` fails (after successful `fsync(final_dir)` and `unlink`) → the final link IS durable (step 4 succeeded). The temp unlink may not be durable, but this is benign: recovery on next cycle will see temp reappeared (if unlink was lost) with final already verified → unlink again. Log at warning, proceed to mark ACTIVE. The file is safely published; only the temp cleanup needs retry.
- If `fsync` fails with EIO (I/O error) → treat as above based on which sync failed. Additionally alert `STORAGE_IO_ERROR` for operator attention (possible disk failure).
- **Never silent:** Every fsync return value is checked. A failed fsync that is ignored is a correctness bug.

**Why the distinction:** `fsync(final_dir)` guards against *losing the published file*. `fsync(temp_dir)` guards against *leaving a stale temp entry*. Losing the published file is a data-loss risk; leaving a temp entry is a cleanup retry. The failure handling reflects this asymmetry.

### 1.6b Content Digest Protocol (rev 5)

**Purpose:** Establish file identity across process restarts when inode comparison is impossible (temp file gone).

**Writer obligations:**
1. During chunk writes, the writer feeds each chunk into an incremental SHA-256 hasher.
2. After the final chunk (before Phase A), the writer finalizes the digest.
3. Phase A records `content_sha256` in the asset row alongside `publication_status='PENDING'`.

**Verification use:**
- In Phase B step 8a (EEXIST with different inode): compute SHA-256 of `final_path`, compare with the recorded digest. Match → identity proven. Mismatch → fail closed.
- In startup recovery: if temp is gone and final exists, compute digest and compare. Match → `fsync(final_dir_fd)` MUST succeed → mark ACTIVE. Mismatch or no digest → fail closed, alert. Fsync failure → stay PENDING, alert.

**Schema:** `world_media_assets.content_sha256 CHAR(64)` (hex-encoded), NULL allowed for backwards compatibility. If NULL (digest not recorded), recovery MUST fail closed — do not assume identity.

**Cost:** One SHA-256 pass over the file during recovery (only when needed). The writer's incremental hashing adds negligible overhead to chunk writes.

**Limitations:** SHA-256 is not a proof against malicious collision, but the threat model here is crash recovery, not adversarial tampering. For this purpose, it reliably distinguishes "this is our file" from "this is a different file."

### 1.6e Stale Temp Cleanup for ACTIVE Assets (rev 12)

**The gap (rev 11):** When `fsync(temp_dir_fd)` fails but the final link is durable, §1.6d permits marking ACTIVE and retrying temp cleanup later. However, the startup recovery (§1.6a) only scans PENDING assets. If the temp entry reappears after a crash (unlink not durable), no described mechanism revisits it. The ACTIVE asset remains published while a stale temp entry lingers indefinitely.

**The mechanism:** A dedicated cleanup path for temp entries belonging to ACTIVE assets. Runs on startup (after PENDING recovery) and periodically (every 15 minutes via the maintenance job).

**Discovery:**
1. List `/data/media/.tmp/*.part` files.
2. For each, extract `reservation_id` from the filename (`{reservation_id}.part`).
3. Query: `SELECT asset_id, final_path FROM world_media_assets WHERE reservation_id = ? AND publication_status = 'ACTIVE'`.
   - If a row exists → candidate for stale temp cleanup.
   - If no row (or status is PENDING) → skip. PENDING assets are handled by §1.6a recovery; missing rows are handled by orphan logic.

**Verification (before unlink):**
1. Acquire the ownership lock for `reservation_id` (non-blocking, inode-verified per §1.1b). If `EWOULDBLOCK` → skip this cycle (someone is active; retry next cycle).
2. `stat(temp_path)` → `(dev_t, ino_t)`. If ENOENT → already cleaned → skip.
3. `stat(final_path)` (from the ACTIVE asset row) → `(dev_f, ino_f)`. If ENOENT → **do NOT unlink temp**. The ACTIVE asset has no file at its final path — this is a data-integrity issue. Log at error, alert `ACTIVE_ASSET_MISSING_FILE`. Leave temp in place for forensic analysis.
4. If `(dev_t, ino_t) == (dev_f, ino_f)` → same inode: the temp entry is a stale alias of the published file. Safe to unlink.
5. If different inodes → **do NOT unlink**. Log at error, alert `TEMP_INODE_MISMATCH` with both inodes, reservation_id, and asset_id. This indicates a bug (two different files) or manual interference. Operator must investigate.

**Cleanup (write-ahead marker protocol) (rev 14):**
1. Acquire ownership lock, verify inode identity (per above).
2. **Write the retry marker BEFORE the filesystem operation (rev 15 — counter preservation):**
   ```sql
   UPDATE world_media_assets 
   SET temp_cleanup_fsync_pending = TRUE,
       temp_cleanup_last_attempt_at = now()
   WHERE reservation_id = ? AND publication_status = 'ACTIVE'
   ```
   - **Rev 19:** The marker write NEVER modifies either failure counter. Counters are initialized to 0 by the schema default and reset only by their specific success conditions (unlink success/ENOENT for unlink counter; fsync success for fsync counter).
   - If the marker was already TRUE (rediscovering a pending cleanup) → counters preserved (untouched by this UPDATE).
   - If the marker was FALSE (new cleanup) → counters retain whatever value they have (should be 0 from prior successes, but never forcibly reset here).
   - If this UPDATE fails (DB error) → abort cleanup, release lock, retry next cycle. Do NOT proceed to unlink without the marker.
   - The marker must be durably committed before the unlink executes.

**When counters increment (rev 16):** The two failure counters are independent:
- `temp_cleanup_fsync_attempts` increments ONLY when `fsync(temp_dir_fd)` returns an error. Reset to 0 on successful fsync (followed by marker clear).
- `temp_cleanup_unlink_attempts` increments ONLY when `unlink(temp_path)` returns an error (other than ENOENT). Reset to 0 on successful unlink.
- Neither increments on: successful operation (resets), rediscovery of pending cleanup (preserved), single-owner skip (not processed), lock acquisition failure (not attempted).

**Consecutive failure definition:** For each counter, failures are consecutive if no success of that operation type intervenes. A successful fsync resets only the fsync counter; a successful unlink resets only the unlink counter. The 5-failure alert fires independently for each counter. The 15-failure escalation (3 alert cycles) applies per counter.

**Alert details:** `TEMP_CLEANUP_FAILED` includes `failure_type` ('fsync' or 'unlink'), `reservation_id`, `attempt_count`, and `last_errno` to distinguish the failure mode.
3. `unlink(temp_path)`. If ENOENT → already gone → reset unlink counter (`UPDATE ... SET temp_cleanup_unlink_attempts = 0`) — the unlink obligation is satisfied by absence. Proceed to step 4 (fsync still required to ensure durability).
   - If `unlink()` fails (other than ENOENT):
     - Increment: `UPDATE ... SET temp_cleanup_unlink_attempts = temp_cleanup_unlink_attempts + 1, temp_cleanup_last_attempt_at = now() WHERE reservation_id = ?`.
     - Log at warning with reservation_id, errno, failure_type='unlink'.
     - If `temp_cleanup_unlink_attempts >= 5` → alert `TEMP_CLEANUP_FAILED` with `failure_type='unlink'`.
     - Do NOT proceed to fsync (nothing was unlinked). Release lock. Retry unlink on next cycle.
     - The marker remains set (from step 2). The fsync counter is unaffected.
   - If `unlink()` succeeds → reset unlink counter: `UPDATE ... SET temp_cleanup_unlink_attempts = 0 WHERE reservation_id = ?`. Proceed to step 4.
4. `fsync(temp_dir_fd)`.
   - If succeeds → clear the marker: `UPDATE ... SET temp_cleanup_fsync_pending = FALSE, temp_cleanup_fsync_attempts = 0 WHERE reservation_id = ?`. **Do NOT reset `temp_cleanup_unlink_attempts` here** (rev 18). The unlink counter resets only on successful unlink (step 3) or observed absence (ENOENT). A successful fsync must not erase unlink-failure history.
     - If the clear UPDATE fails (DB error) → log at error. The marker remains set; next cycle will retry the fsync (harmless) and attempt to clear again. Do NOT lose the retry state.
   - If fails → marker is already set (from step 2). Increment: `UPDATE ... SET temp_cleanup_fsync_attempts = temp_cleanup_fsync_attempts + 1, temp_cleanup_last_attempt_at = now() WHERE reservation_id = ?`. If attempts >= 5 → alert `TEMP_CLEANUP_FAILED`.
5. Release ownership lock.

**Crash windows (all covered):**
| Crash point | Marker state | Temp state | Recovery |
|-------------|--------------|------------|----------|
| After marker write, before unlink | Set | Exists | Recovery finds marker + temp exists → performs unlink + fsync → clears marker. |
| After unlink, before fsync | Set | Absent (or reappears) | Recovery finds marker → fsyncs directory (temp absent is fine) → clears marker on success. |
| After fsync succeeds, before marker clear | Set | Absent | Recovery finds marker → fsyncs again (idempotent) → clears marker. No harm. |
| Before marker write | Not set | Exists | Normal discovery finds temp file → starts cleanup from step 1. |

**Why write-ahead:** The rev-13 gap was writing the marker after the unlink+fsync. A crash between unlink and marker-write left no trace. By writing the marker first, every filesystem mutation is preceded by a durable intent record. The marker is cleared only after the full sequence (unlink + fsync) succeeds.

**Persistent fsync-retry state (rev 13):**
The problem: if `unlink()` succeeds but `fsync(temp_dir_fd)` fails, and the temp entry does not reappear, the next cycle's file-listing discovery finds nothing. The retry state must persist in the database, not depend on the temp file's presence.

**Schema (rev 16):**
```sql
ALTER TABLE world_media_assets ADD COLUMN temp_cleanup_fsync_pending BOOLEAN DEFAULT FALSE;
ALTER TABLE world_media_assets ADD COLUMN temp_cleanup_fsync_attempts INT DEFAULT 0;
ALTER TABLE world_media_assets ADD COLUMN temp_cleanup_unlink_attempts INT DEFAULT 0;
ALTER TABLE world_media_assets ADD COLUMN temp_cleanup_last_attempt_at TIMESTAMPTZ;
```
- `temp_cleanup_fsync_pending`: TRUE if a cleanup is in progress or needs fsync retry.
- `temp_cleanup_fsync_attempts`: Consecutive `fsync(temp_dir_fd)` failures. Reset to 0 on success.
- `temp_cleanup_unlink_attempts`: Consecutive `unlink(temp_path)` failures. Reset to 0 on success.
- The two counters are independent. An fsync failure does not affect the unlink counter and vice versa.

**Note on rev 13–15 naming:** Earlier revisions used `temp_cleanup_attempts` for the fsync counter. Rev 16 renames it to `temp_cleanup_fsync_attempts` for clarity and adds the separate unlink counter. Implementations must use the rev-16 names.

**On fsync failure (rev 16 — write-ahead):** The marker was already written in step 2 (before unlink). On fsync failure:
1. `UPDATE world_media_assets SET temp_cleanup_fsync_attempts = temp_cleanup_fsync_attempts + 1, temp_cleanup_last_attempt_at = now() WHERE reservation_id = ? AND publication_status = 'ACTIVE'`.
   - The `temp_cleanup_fsync_pending` flag remains TRUE (it was set in step 2).
   - Do NOT reset the counter; increment the existing value.
2. Log at warning with reservation_id, attempt count, errno, failure_type='fsync'.
3. If `temp_cleanup_fsync_attempts >= 5` → alert `TEMP_CLEANUP_FAILED` with `failure_type='fsync'` (once per 5-failure window).

**Note:** This subsection supersedes the rev-13 "set marker after failure" ordering. The marker is written write-ahead (step 2); this subsection only increments the counter. Every normative description in this document uses the write-ahead protocol.

**On cleanup cycle (startup and periodic):**

**Single-owner rule (rev 15):** Each reservation is processed at most once per cycle. The worker maintains an in-memory `processed: Set<reservation_id>`. Pass 1 (file listing) adds each handled reservation to the set. Pass 2 (DB query) skips any reservation already in the set. This prevents double-processing when a Pass-1 fsync failure leaves the marker set, which Pass 2 would otherwise retry immediately in the same cycle (double-counting failures or prematurely clearing).

1. Initialize `processed = {}` (empty set).
2. **Pass 1 — file-listing discovery:** For each temp file candidate, if `reservation_id` in `processed` → skip. Otherwise perform cleanup protocol (marker write → unlink → fsync). Add `reservation_id` to `processed` regardless of outcome.
3. **Pass 2 — DB pending markers:** Query: `SELECT reservation_id, temp_cleanup_fsync_attempts, temp_cleanup_unlink_attempts FROM world_media_assets WHERE temp_cleanup_fsync_pending = TRUE AND publication_status = 'ACTIVE'`. For each row, if `reservation_id` in `processed` → skip (already handled in Pass 1). Otherwise perform fsync retry. Add to `processed`.
   - These are markers from interrupted cleanups (crash after marker write, or fsync failures).
3. For each pending reservation:
   - Acquire ownership lock (non-blocking). If fails → skip.
   - Check if temp file exists:
     - If exists → verify inode identity → proceed with unlink + fsync (steps 3–4 of cleanup protocol). The marker is already set.
     - If absent → the unlink obligation is satisfied by absence (rev 18 ENOENT rule). Reset unlink counter: `UPDATE ... SET temp_cleanup_unlink_attempts = 0 WHERE reservation_id = ?`. Then proceed directly to `fsync(temp_dir_fd)`. **The absent-file observation resets the unlink counter in recovery exactly as ENOENT does in normal cleanup** (rev 19 consistency). The subsequent fsync result affects only the fsync counter.
   - `fsync(temp_dir_fd)`:
     - If succeeds → clear marker: `UPDATE ... SET temp_cleanup_fsync_pending = FALSE, temp_cleanup_fsync_attempts = 0`. Log at info. **Do NOT reset unlink counter** (rev 18 invariant).
     - If fails → increment attempts. If >= 5 → alert `TEMP_CLEANUP_FAILED`.
   - Release lock.
4. The fsync on the directory is valid even when no specific temp file exists — it ensures all prior directory operations are durable.

**Alert lifecycle (rev 21 — complete contract):**

**Alert identity:** Each alert is uniquely identified by `(reservation_id, failure_type)`. The two failure types ('unlink', 'fsync') have fully independent lifecycles. An alert for one type never affects the other.

**Incident model:** Each `(reservation_id, failure_type)` alert follows an incident lifecycle:
- **Inactive:** Counter < 5. No alert.
- **Active:** Counter >= 5. Alert fired. The incident is "open."
- **Resolved:** Counter reset to 0 via operation success. The incident is "closed."
- **Recurrence:** After resolution, if the counter reaches 5 again → new incident (new alert). The previous incident's history does not carry over.

**Firing rules:**
- First fire when counter reaches 5.
- Re-fire at 10, 15, 20, ... (every 5 consecutive failures) while the incident remains open. This ensures ongoing visibility for persistent failures without spamming every cycle.
- Each fire includes: `reservation_id`, `failure_type`, `attempt_count`, `last_errno`, `incident_id` (UUID generated at first fire, preserved across re-fires of the same incident).

**Resolution rules:**
- Unlink alert resolves when `unlink()` succeeds OR temp absence is observed (ENOENT) → `temp_cleanup_unlink_attempts` reset to 0.
- Fsync alert resolves when `fsync()` succeeds → `temp_cleanup_fsync_attempts` reset to 0 and marker cleared.
- Resolution is automatic and immediate upon the successful operation. No manual action required or sufficient.
- Manual acknowledgment (operator marking "seen") does NOT resolve the alert. It suppresses notifications but the incident remains open until the operation succeeds. This prevents dismissing a persistent storage issue.

**Recurrence rules:**
- After resolution (counter reset to 0), the incident is closed.
- If failures recur and the counter reaches 5 again → new incident with new `incident_id`. Escalation state resets (see below).
- The new incident is independent; it does not "resume" the old incident's escalation level.

**Escalation:**
- If a single incident's counter reaches 15 (3rd fire: at 5, 10, 15) → escalate to `TEMP_CLEANUP_PERSISTENT_FAILURE` (critical) with the same `incident_id` and `failure_type`.
- Escalation is per-incident. If the incident resolves and a new incident begins later, escalation starts over (fires at 5, escalates at 15 of the new incident).
- The critical alert clears when the underlying operation succeeds (same as the warning alert). There is no separate critical-resolution path.

**Example — full lifecycle:**
1. Unlink fails 5x → incident U1 opens (warning, `failure_type='unlink'`, `incident_id=aaa`).
2. Unlink fails 5 more (total 10) → U1 re-fires (still warning).
3. Unlink fails 5 more (total 15) → U1 escalates to critical.
4. Unlink succeeds → `unlink_attempts=0` → U1 resolves (both warning and critical clear).
5. Later, unlink fails 5x again → new incident U2 opens (warning, `incident_id=bbb`, NOT escalated). The prior escalation does not carry over.
6. Meanwhile, fsync fails 5x → incident F1 opens (`failure_type='fsync'`, `incident_id=ccc`). Independent of U1/U2.

**Incident persistence contract (rev 22):**

**Schema:**
```sql
CREATE TABLE temp_cleanup_incidents (
    incident_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL,
    failure_type TEXT NOT NULL CHECK (failure_type IN ('unlink', 'fsync')),
    status TEXT NOT NULL CHECK (status IN ('open', 'escalated', 'resolved')),
    -- 'open': warning alert fired, not yet escalated
    -- 'escalated': critical alert fired (counter reached 15)
    -- 'resolved': operation succeeded, incident closed
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    escalated_at TIMESTAMPTZ,
    last_fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_fired_count INT NOT NULL,  -- counter value at last fire (5, 10, 15...)
    acknowledged_at TIMESTAMPTZ,    -- operator ack (suppresses notifications, does NOT resolve)
    -- No UNIQUE on (reservation_id, failure_type, status): multiple resolved
    -- incidents must coexist for audit. Uniqueness enforced below.
);
-- Partial unique index: at most one open/escalated incident per (reservation, type).
-- Resolved incidents are excluded, allowing unlimited audit history.
CREATE UNIQUE INDEX temp_cleanup_incidents_open_unique 
    ON temp_cleanup_incidents (reservation_id, failure_type) 
    WHERE status IN ('open', 'escalated');
```

**Atomicity with counters:** Incident state changes occur in the SAME database transaction as counter updates:
- When counter increments to 5 (first fire): `INSERT INTO temp_cleanup_incidents (reservation_id, failure_type, status='open', last_fired_count=5)` in the same txn as the counter UPDATE. If the txn rolls back, neither the counter nor the incident persists.
- When counter reaches 10, 15, 20, 25, ...: `UPDATE temp_cleanup_incidents SET last_fired_at=now(), last_fired_count=<actual_counter_value> WHERE incident_id=? AND status IN ('open','escalated')`.
  - `last_fired_count` is always the actual counter value at firing time (5, 10, 15, 20, ...), not a hardcoded value.
  - The update path covers both 'open' and 'escalated' statuses. After escalation at 15, subsequent re-fires (20, 25, ...) continue to update the same incident row.
  - At 15 (first escalation): also `SET status='escalated', escalated_at=now()` in the same UPDATE.
  - Notifications after escalation: the critical alert re-fires at 20, 25, 30, ... with `severity='critical'` (not downgraded to warning). Each re-fire includes the same `incident_id` so the alert system correlates them.
- When operation succeeds: `UPDATE temp_cleanup_incidents SET status='resolved', resolved_at=now() WHERE reservation_id=? AND failure_type=? AND status IN ('open','escalated')` in the same txn as the counter reset. Atomic: either both the counter resets and the incident resolves, or neither does.

**Crash recovery:**
- **Crash after operation succeeds but before incident resolution commits:** The transaction rolls back. Counter remains >= 5, incident remains open/escalated. Next cycle retries the operation (which will succeed again, idempotent) and resolves the incident. No stale resolved state.
- **Crash after incident opens but before alert delivery:** The incident row and outbox event are committed atomically (same txn as the counter). On restart, the delivery worker finds the 'pending' outbox event and sends it. The incident is not lost. (Rev 25: the database outbox is the authoritative delivery mechanism; there is no alternative receiver-deduplication path.)
- **Recurrence UUID:** When a new incident opens (counter reaches 5 after a prior resolution), `gen_random_uuid()` generates a fresh ID. The old resolved incident remains in the table with `status='resolved'` (for audit). The partial unique index only applies to open/escalated statuses, so the new incident inserts cleanly. The old resolved row remains for audit.
- **Stale incident reconciliation:** On startup, query for incidents with `status IN ('open','escalated')`. For each, check the current counter value:
  - If counter < 5 → the operation must have succeeded without resolving the incident (crash window). Resolve it: `SET status='resolved', resolved_at=now()`. Log at warning (`STALE_INCIDENT_RESOLVED`).
  - If counter >= 5 → incident is legitimately open. Re-emit alert if delivery unconfirmed (see delivery protocol below).
  - This ensures a resolved incident cannot remain active after recovery.

**Alert delivery protocol (rev 25 — outbox pattern):**

**Problem rev 24 had:** A single `delivery_confirmed_at` on the incident row cannot distinguish a crash-retry (same notification, send again) from a legitimate re-fire (new notification for the same incident at count 10, 15, 20...). Both share the incident_id. Rev 25 separates these with a durable outbox.

**Two identities:**
- `incident_id`: identifies the continuing incident (one per failure episode).
- `delivery_event_id`: identifies one specific notification event (one per firing). Each re-fire generates a NEW event with a NEW ID, even for the same incident.

**Outbox schema:**
```sql
CREATE TABLE temp_cleanup_delivery_outbox (
    delivery_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES temp_cleanup_incidents(incident_id),
    reservation_id UUID NOT NULL,
    failure_type TEXT NOT NULL,
    fire_count INT NOT NULL,  -- the counter value that triggered this event (5, 10, 15...)
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    -- 'pending': awaiting delivery
    -- 'sent': delivery confirmed by receiver
    -- 'failed': delivery failed after max retries (10); requires manual intervention
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    last_error TEXT,
    claimed_by TEXT,           -- worker ID holding the claim (for concurrent workers)
    claimed_at TIMESTAMPTZ,    -- when the claim was taken
    claim_token UUID,          -- unique per claim; required for state updates (fencing)
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- earliest eligible retry time
    UNIQUE (incident_id, fire_count)  -- one delivery event per firing
);
CREATE INDEX ON temp_cleanup_delivery_outbox (status, next_attempt_at) 
    WHERE status = 'pending';
```

**Event creation (in the same txn as the counter/incident update):**
- When counter reaches 5 (new incident): INSERT incident + INSERT outbox event (`fire_count=5`, `severity='warning'`, `status='pending'`).
- When counter reaches 10, 15, 20... (re-fire): UPDATE incident (`last_fired_count`, `last_fired_at`) + INSERT new outbox event (`fire_count=10`, etc.). At 15+: `severity='critical'`.
- The `UNIQUE(incident_id, fire_count)` prevents duplicate events for the same firing (e.g., if the txn retries).
- Remove `delivery_confirmed_at` and `delivery_attempts` from the incidents table (rev 24 columns superseded by the outbox).

**Delivery worker protocol:**
1. **Claim:** 
   ```sql
   UPDATE temp_cleanup_delivery_outbox 
   SET claimed_by=<worker_id>, claimed_at=now(), claim_token=gen_random_uuid()
   WHERE delivery_event_id = (
     SELECT delivery_event_id FROM temp_cleanup_delivery_outbox 
     WHERE status='pending' 
       AND next_attempt_at <= now()
       AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
   ) RETURNING *;
   ```
   - `next_attempt_at <= now()` enforces backoff: failed events wait before retry.
   - `FOR UPDATE SKIP LOCKED` ensures concurrent workers don't claim the same event.
   - Stale claims (older than 5 min, worker crashed) are reclaimable.
   - Each claim generates a fresh `claim_token` (UUID). The worker must present this token for all subsequent state updates.
2. **Send:** Transmit to the alert system with `delivery_event_id` as the deduplication key.
3. **Confirm (fenced):** On success: `UPDATE ... SET status='sent', sent_at=now(), claimed_by=NULL, claim_token=NULL WHERE delivery_event_id=? AND claim_token=<token>`.
   - If 0 rows updated → the claim was superseded (another worker reclaimed). Do NOT treat as delivered; the new claimant owns the event.
4. **Retry (fenced):** On failure: 
   ```sql
   UPDATE ... SET attempts=attempts+1, last_attempt_at=now(), last_error=?,
       claimed_by=NULL, claimed_at=NULL, claim_token=NULL,
       next_attempt_at = now() + (CASE 
           WHEN attempts=0 THEN interval '1 minute'
           WHEN attempts=1 THEN interval '5 minutes'
           WHEN attempts=2 THEN interval '15 minutes'
           WHEN attempts=3 THEN interval '30 minutes'
           ELSE interval '1 hour' END)
   WHERE delivery_event_id=? AND claim_token=<token>;
   ```
   - If 0 rows → claim superseded; abort (the new claimant will handle retry scheduling).
   - `next_attempt_at` enforces the backoff. Initial events have `next_attempt_at=now()` (immediately eligible).
5. **Exhausted (10th failure — fenced transaction):** When `attempts` would increment to 10, execute as a single fenced transaction:
   ```sql
   BEGIN;
   UPDATE temp_cleanup_delivery_outbox 
   SET status='failed', 
       attempts=10, 
       last_attempt_at=now(), 
       last_error=?,
       claimed_by=NULL, claimed_at=NULL, claim_token=NULL
   WHERE delivery_event_id=? AND claim_token=<token> AND status='pending';
   -- If 0 rows: claim superseded, abort (do not transition).
   COMMIT;
   ```
   - Attempts 1–9: event remains `status='pending'` with `next_attempt_at` set per backoff schedule. Eligible for automatic retry.
   - Attempt 10: event transitions directly to `status='failed'` in the same UPDATE (no intermediate pending state). The `next_attempt_at` is irrelevant (no automatic retry).
   - After commit: log at critical (`ALERT_DELIVERY_FAILED` with `delivery_event_id`, `incident_id`, `failure_type`, `attempts=10`).
   - The `failed` event remains in the outbox indefinitely for manual intervention. An operator may: (a) inspect `last_error`, (b) reset to `pending` with `attempts=0` and `next_attempt_at=now()` for manual retry, or (c) leave as failed (audit trail). It is never auto-deleted or silently dropped.
   - Manual retry reuses the same `delivery_event_id` (receiver deduplication still applies if the original send actually succeeded).

**Claim fencing rationale:** Without the token, worker B (reclaiming a stale claim) and worker A (still processing) could both update the event. Worker A's late success could overwrite worker B's retry scheduling, or vice versa. The token ensures only the current claimant modifies state. The receiver's `delivery_event_id` deduplication remains the backstop against duplicate external notifications.

**Receiver contract (rev 25):**
- The receiver deduplicates on `delivery_event_id`, NOT `incident_id`.
- Receiving the same `delivery_event_id` twice → suppress duplicate (crash retry).
- Receiving a different `delivery_event_id` for the same `incident_id` → new notification (legitimate re-fire). The receiver correlates by `incident_id` for display but notifies per event.
- This resolves the rev-24 ambiguity: crash retries and re-fires are distinguishable by their event IDs.

**Crash behavior:**
- **Crash after event insert, before delivery:** Event remains 'pending'. On restart, delivery worker claims and sends. At-least-once.
- **Crash after send, before confirm:** Event remains 'pending' (or 'claimed' with stale claim). On restart, reclaimed and re-sent. Receiver deduplicates by `delivery_event_id` → no double-page.
- **Crash during claim:** Stale claim (5 min timeout) → another worker reclaims. No event lost.
- **Simultaneous workers:** `FOR UPDATE SKIP LOCKED` guarantees exactly one worker claims each event. No concurrent duplicate sends.

**Acknowledgment persistence:** `acknowledged_at` is set by operator action (separate txn). It does NOT change `status`. An acknowledged incident remains 'open' or 'escalated' until the operation succeeds. The alert system suppresses notifications for acknowledged incidents but continues to track them. Acknowledgment is cleared (set to NULL) when a new incident opens (recurrence).

**Why this works:**
- The retry state is in the database, surviving process restarts and crashes.
- The retry does not require the temp file to exist — it fsyncs the directory, which is the actual durability mechanism.
- The attempt counter provides bounded alerting without infinite loops.
- If the temp entry reappears, the file-listing discovery handles it (unlink again). If not, the DB-driven retry ensures the fsync is eventually confirmed or alerted.

**Failure handling (bounded retries):**
- If `unlink()` fails (other than ENOENT) → log at warning, retry next cycle. After 5 consecutive failures → alert `TEMP_CLEANUP_FAILED` with reservation_id and errno. Continue retrying (the alert ensures operator awareness; the retry ensures eventual cleanup if the issue resolves).
- If `fsync(temp_dir_fd)` fails → log at warning. The unlink may not be durable; the temp entry may reappear. Retry next cycle. After 5 consecutive fsync failures → alert `TEMP_CLEANUP_FAILED`. The ACTIVE asset is unaffected (final is durable).
- **Bounded, not infinite:** Each retry counter resets only on its operation's success. The alert fires once per 5-failure window (not on every failure) to avoid alert spam. Manual intervention alone does NOT clear the alert — the underlying operation (unlink or fsync) must succeed. An operator fixing permissions does not clear the alert; the next successful unlink does.

**Why this is safe:**
- Only acts on temp files with a corresponding ACTIVE asset. PENDING assets are explicitly excluded (different recovery path).
- Inode verification ensures we only unlink a temp entry that aliases the published file. We never delete a temp file that contains different bytes.
- Ownership lock prevents interference with any (buggy) active writer.
- The ACTIVE asset's final file is never touched — only the stale temp directory entry is removed.

**Distinction from PENDING recovery:** §1.6a recovery handles PENDING assets (publication incomplete). §1.6e handles ACTIVE assets with leftover temp entries (publication complete, cleanup incomplete). The two never overlap: PENDING recovery skips ACTIVE assets; §1.6e skips PENDING assets.

### 1.6a Recovery Ownership Protocol (rev 3)

**The problem:** The startup scan says "any worker finding a PENDING asset can link or activate." But two recovery workers — or a recovery worker and the still-alive original writer — could race: both renaming, one activating while the other is still modifying the file, or acting on stale filesystem observations.

**The rule:** A recovery worker MUST acquire the ownership lock (via the inode-verified protocol in §1.1b) BEFORE performing any filesystem operation on a PENDING asset. Database-only observations (reading the PENDING row) do not require the lock, but any `link`, `stat` used for a decision, or `unlink` does.

**Protocol:**
1. Recovery worker scans for `publication_status='PENDING'` assets.
2. For each PENDING asset, attempt to acquire the ownership lock for its `reservation_id` using the inode-verified protocol.
   - If `EWOULDBLOCK` → another worker (or the original writer) owns it → SKIP this asset this cycle. Do not touch its files. Do not update its row.
   - If acquired → this worker owns the recovery for this asset.
3. While holding the ownership lock, perform the filesystem checks and operations (stat temp/final, link if needed).
4. Update the asset row (`ACTIVE` or `PUBLICATION_FAILED`).
5. Release the ownership lock via `flock(LOCK_UN)` and close. The lockfile persists (rev 4 permanent-lockfile rule).

**Why this works:**
- **Recovery vs. original writer:** The original writer holds the ownership lock through all three phases (A, B, C). If the writer is still alive and working, the recovery worker's acquire fails → skips. The writer completes normally. No interference.
- **Recovery vs. crashed writer:** The kernel released the lock on crash. The recovery worker acquires it and proceeds. The original writer is dead; its file descriptors are closed.
- **Recovery vs. recovery:** Two workers scanning simultaneously → exactly one acquires the lock → the other skips. No double-link, no conflicting updates.
- **Stale filesystem observations:** The lock guarantees no other party is modifying the files. The worker's `stat` results are valid for the duration of the lock hold.

**Lockfile existence (rev 7):** Under the permanent-lockfile rule, the lockfile always exists for a reservation ID (created on first acquisition, never unlinked in normal operations). If the path is unexpectedly absent (e.g., manual deletion or out-of-scope GC), the recovery worker creates it with `O_CREAT` during acquisition. This is safe: if no lockfile exists and the reservation is not active, no legitimate owner exists.

**Crash boundaries and recovery:**

| Crash point | DB state | FS state | Recovery |
|-------------|----------|----------|----------|
| During Phase A (before COMMIT) | Transaction rolls back; no asset row; reservation still active | Temp file exists | Reservation remains active; writer (if alive) can retry; expiry claim handles if dead |
| After Phase A COMMIT, before Phase B | Asset PENDING; reservation COMMITTED | Temp file exists | Startup scan: temp exists → execute Phase B + C |
| During Phase B (link) | Asset PENDING; reservation COMMITTED | Temp exists, or both temp+final (same inode), or final only | Startup scan: verify identity (inode/digest) → `fsync(final_dir_fd)` MUST succeed → unlink temp if needed → `fsync(temp_dir_fd)` → mark ACTIVE; if EEXIST with different file → verify or fail safe; if fsync fails → stay PENDING |
| After Phase B, before Phase C | Asset PENDING; reservation COMMITTED | File at final path (temp unlinked) | Startup scan: verify identity via digest → `fsync(final_dir_fd)` MUST succeed → mark ACTIVE; if fsync fails → stay PENDING |
| After Phase C | Asset ACTIVE; reservation COMMITTED | File at final path | Normal state; no recovery needed |

**What this guarantees:**
- No file exists at a final path without a database row (the PENDING row is created before the link).
- No PENDING asset is served to readers (serving layer filters).
- Every intermediate state is discoverable via the `publication_status` column.
- The link+unlink sequence is idempotent (safe to retry).
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

4. **I4 (Commit phases):** Publication proceeds in three ordered phases: (A) Database transaction commits the asset row as PENDING and the reservation as COMMITTED atomically; (B) Filesystem link+unlink moves temp→final (idempotent; link never overwrites); (C) Database transaction marks the asset ACTIVE. A 0-row reservation UPDATE in Phase A causes full ROLLBACK of Phase A (including the asset INSERT). Phases B and C are idempotent and recoverable via the startup scan. No single transaction spans the DB and filesystem.

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

8. **I8 (Publication atomicity):** No file exists at a final (published) path without a corresponding asset database row. The asset row (as PENDING) is committed before the link executes. Readers never see PENDING assets.

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

### 6.8 Crash-safe publication (rev 6 updated)
- **Crash after Phase A COMMIT, before Phase B:** Kill the writer after the DB transaction commits but before the link. Assert: asset row exists with `PENDING`, reservation is `COMMITTED`, temp file exists. Restart → startup scan finds PENDING asset with temp file → executes link → fsync → unlink → fsync → marks ACTIVE. Assert: file at final path, asset ACTIVE, no orphan.
- **Crash during Phase B (after link, before fsync):** Kill after `link()` returns but before `fsync(final_dir)`. Assert: recovery checks final_path. If link appears present → verify identity (inode or digest) → **MUST issue `fsync(final_dir)` and confirm success BEFORE unlinking temp** (rev 7, §1.6d). Only then unlink temp → **MUST issue `fsync(temp_dir_fd)` and confirm success** → mark ACTIVE. If `fsync(final_dir)` fails → stay PENDING, preserve temp, alert. If `fsync(temp_dir)` fails (after final durable) → mark ACTIVE, log warning, retry temp cleanup (§1.6d). If link not durable (final doesn't exist) → retry link. No data loss. **Identity alone does not authorize unlinking; durability must be confirmed via fsync.**
- **Recovery fsync failure:** Simulate `fsync(final_dir)` failing (EIO) during recovery. Assert: recovery does NOT unlink temp. Asset remains PENDING. Alert `FSYNC_FAILED` fires. Temp entry preserved for retry. A failed fsync is never treated as successful publication.
- **Crash during Phase B (after fsync, before unlink):** Kill after `fsync(final_dir)` but before `unlink(temp)`. Assert: temp and final are same inode → recovery MUST re-issue `fsync(final_dir_fd)` and confirm success → unlink temp → `fsync(temp_dir_fd)` → mark ACTIVE. Prior sync does not substitute for recovery sync.
- **Crash after Phase B, before Phase C:** File at final path (temp unlinked), asset PENDING with digest. Assert: recovery verifies identity via digest → `fsync(final_dir_fd)` MUST succeed → marks ACTIVE. If fsync fails → stay PENDING, alert. Assert: no duplicate file.
- **Crash after Phase B, identity unverifiable:** File at final path, asset PENDING, but digest is NULL or mismatches. Assert: recovery does NOT mark ACTIVE. Marks `PUBLICATION_IDENTITY_UNVERIFIED`, alerts. File untouched.
- **Temp lost:** PENDING asset with neither temp nor final file exists. Assert: marked `PUBLICATION_FAILED`, alert fires, no silent data loss.
- **Reader isolation:** During the PENDING window (after Phase A, before Phase C), assert that the serving layer does not return the asset (filtered by `publication_status`).

### 6.9 Single-writer ownership (new, rev 2)
- **Race to acquire:** Two writers attempt to open the same reservation_id concurrently. Assert: exactly one acquires the ownership lock (`LOCK_EX|LOCK_NB`); the other gets `EWOULDBLOCK` → aborts with `WRITER_CONFLICT` without opening the data file or writing any bytes.
- **Crash releases ownership:** Writer acquires ownership lock, then crashes (kill -9). Assert: kernel releases the lock. A new writer can acquire ownership for the same reservation (after validating the reservation is still active).
- **Stale worker:** Writer holds ownership lock; reservation is claimed (ABANDONED) by the expiry worker. A restarted worker validates state → sees ABANDONED → does NOT acquire the lock, does NOT write. Assert: no bytes written to the abandoned temp file.
- **Lockfile permanence:** After successful commit, assert the `.lock` file STILL EXISTS on disk (not removed). After abandoned-temp cleanup, assert the `.lock` file STILL EXISTS. Normal operations never unlink lockfiles (rev 4 invariant).

### 6.10 Concurrent recovery (new, rev 3)
- **Setup:** Create a PENDING asset (simulate crash after Phase A). Start two recovery workers simultaneously.
- **Assert:** Exactly one worker acquires the ownership lock; the other skips the asset (no filesystem operations, no row updates).
- **Assert:** The asset is linked (if needed) and marked ACTIVE exactly once. No double-link, no conflicting updates.
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
- [x] Permanent lockfiles (rev 4, §1.1a/§1.1b) — never unlinked in normal ops; only kernel lock released. (Rev 3 unlink protocol superseded.)
- [x] Lock lifecycle clarified (rev 3) — LOCK_SH covers Phase A only; ownership lock covers all phases; I4 updated to three-phase boundaries.
- [x] Permanent lockfiles (rev 4) — never unlinked during normal ops; GC is separate with 7-day grace.
- [x] No-overwrite publication (rev 4) — link() not rename(); EEXIST triggers verification; collision fails safe.
- [x] Content-digest identity (rev 5, §1.6b) — SHA-256 recorded in Phase A; EEXIST with different inode requires digest match; size/metadata alone rejected.
- [x] Recovery verification parity (rev 5) — startup recovery uses identical identity checks as Phase B; no shortcut to ACTIVE.
- [x] Filesystem requirements (rev 5, §1.6c) — same-filesystem enforced at startup; directory sync ordering specified; crash boundaries for link/unlink durability.
- [x] Authoritative durability order (rev 6) — link → fsync(final_dir) → unlink → fsync(temp_dir); no exceptions; Phase B and §1.6c agree.
- [x] Nested mount detection (rev 6) — startup scans /proc/mounts; per-publication st_dev check on actual destination.
- [x] Stale tests updated (rev 6) — §6.8 uses link/unlink with digest verification; §6.9 asserts lockfile permanence.
- [x] Recovery durability ordering (rev 7, §1.6d) — recovery must fsync(final_dir) before unlink(temp); fsync failure behavior defined (final_dir failure → preserve temp, stay PENDING; temp_dir failure → proceed, retry cleanup).
- [x] Stale language removed (rev 7) — all rename→link/unlink; lockfile cleanup→permanent; §1.6a recovery uses link terminology.
- [x] Recovery durability consistency (rev 8) — every recovery path routes through §1.6d; fsync(final_dir) required before unlink or ACTIVE even when temp is gone; syncing never substitutes for identity.
- [x] Crash tables and tests consistent (rev 9) — §1.6c, §6.8, §6.14, §6.16 all require: identity → fsync(final_dir) → unlink → fsync(temp_dir) → ACTIVE. No shortcuts.
- [x] Full sweep (rev 10) — §6.13 retry test and §6.8 after-link test include fsync(temp_dir_fd) with failure behavior; zero remaining unlink→ACTIVE shortcuts.
- [x] Fsync failure policy consistent (rev 11) — final_dir failure → PENDING; temp_dir failure (final durable) → ACTIVE + retry cleanup. No blanket statements.
- [x] Stale temp cleanup for ACTIVE assets (rev 12, §1.6e) — bounded retry discovers temp entries via reservation_id, verifies inode identity, safely unlinks with fsync; PENDING/ACTIVE paths never overlap.
- [x] Persistent fsync-retry state (rev 13) — DB columns track pending temp_dir fsyncs; retry occurs via directory fsync even when temp absent; survives restarts.
- [x] Write-ahead marker (rev 14) — DB marker written BEFORE unlink(); cleared only after fsync succeeds; crash windows all covered; DB failure handling defined; alert resolution rule explicit.
- [x] Retry accounting (rev 15) — single-owner per cycle prevents double-processing; conditional counter reset preserves history; attempts increment only on fsync failure.
- [x] Legacy subsection removed (rev 16) — write-ahead is the only normative protocol; no post-failure marker writes.
- [x] Separate unlink counter (rev 16) — temp_cleanup_unlink_attempts tracks unlink failures independently; 5-failure alert per counter.
- [x] Independent alert lifecycle (rev 17) — unlink alert clears on unlink success; fsync alert clears on fsync success; no cross-contamination; escalation per counter.
- [x] Counter reset isolation (rev 18) — fsync success resets only fsync counter; unlink counter resets only on unlink success/ENOENT; stale manual-clear text removed.
- [x] Marker-counter separation (rev 19) — marker write never touches counters; pending recovery applies ENOENT reset consistently; fsync affects only fsync counter.
- [x] Test consistency (rev 20) — §6.21 rewritten to match rev 19; no contradictory marker-reset language remains.
- [x] Complete alert lifecycle (rev 21) — identity per (reservation_id, failure_type); incident model with resolution/recurrence; escalation resets on new incident; manual ack never resolves.
- [x] Incident persistence contract (rev 22) — DB table with atomic counter+incident updates; crash recovery reconciles stale incidents; recurrence generates fresh UUIDs.
- [x] Partial unique index (rev 23) — uniqueness on (reservation_id, failure_type) WHERE status IN ('open','escalated'); multiple resolved rows allowed for audit.
- [x] Update path and delivery contract (rev 24) — covers open+escalated; last_fired_count uses actual value; delivery_confirmed_at with at-least-once + idempotent receiver.
- [x] Outbox pattern (rev 25) — separates incident_id from delivery_event_id; receiver deduplicates by event; concurrent workers use SKIP LOCKED; stale alternative removed.
- [x] Backoff and fencing (rev 26) — next_attempt_at enforces retry delays; claim_token prevents stale workers from overwriting; receiver dedup remains backstop.
- [x] Legacy cleanup (rev 27) — removed delivery_confirmed_at/delivery_attempts from incident schema; fixed stale test to use outbox.
- [x] 10th-failure transaction (rev 27) — single fenced UPDATE transitions to 'failed'; attempts 1-9 remain pending with backoff; manual retry path defined.
- [x] No implementation written; design-only.

### 6.13 No-overwrite publication (new, rev 4)
- **Pre-existing destination (different bytes):** Setup: final_path already contains a file with different bytes (simulating a collision or stale file). Writer attempts Phase B `link(temp, final)`.
- **Assert:** `link()` fails with `EEXIST`. The writer does NOT overwrite. The verification step (8a) detects the inode mismatch and the absence of a matching asset row → marks `PUBLICATION_FAILED`, alerts `PUBLICATION_COLLISION`. The existing file is byte-identical before and after (verify via checksum).
- **Retry with correct file:** Setup: writer crashes after `link()` succeeds but before `unlink(temp)`. On recovery, temp and final are the same inode. Recovery worker re-runs Phase B.
- **Assert:** `link()` fails with `EEXIST`, but verification (8a) sees `(dev_f, ino_f) == (dev_t, ino_t)` → treats as idempotent success → `fsync(final_dir_fd)` MUST succeed → unlinks temp → `fsync(temp_dir_fd)` → marks ACTIVE. No duplicate, no error. If `fsync(final_dir)` fails → stay PENDING, alert. If `fsync(temp_dir)` fails (final durable) → mark ACTIVE, log warning, retry cleanup per §1.6d.
- **Retry after full completion:** Setup: Phase B and C both completed (file at final, asset ACTIVE), but the writer crashes before releasing locks. Recovery worker scans and finds the asset is ACTIVE (not PENDING).
- **Assert:** Recovery skips (not PENDING). No re-link, no re-activation. Idempotent.
- **Collision with active asset:** Setup: an ACTIVE asset exists at final_path for reservation R1. A buggy writer for R2 attempts to publish to the same final_path.
- **Assert:** `link()` fails with `EEXIST`. Verification finds the ACTIVE asset row for R1 (different reservation_id) → fails safe, alerts. R1's file is untouched. R2's asset is marked `PUBLICATION_FAILED`.

### 6.14 Content-digest identity verification (new, rev 5)
- **Digest match:** Setup: PENDING asset with recorded SHA-256; temp file gone; final_path exists with different inode but matching digest. Recovery computes digest.
- **Assert:** Digests match → `fsync(final_dir_fd)` MUST succeed → mark ACTIVE. The file is the correct one AND its durability is confirmed. If fsync fails → stay PENDING.
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
- **Assert:** Recovery checks final_path. If link appears present → verify identity → `fsync(final_dir_fd)` MUST succeed → unlink temp → `fsync(temp_dir_fd)` → mark ACTIVE. If fsync fails → stay PENDING. If not durable (final doesn't exist) → retry link. No data loss, no overwrite.
- **Crash after unlink, before fsync:** Kill after `unlink(temp)` returns but before `fsync(temp_dir)`.
- **Assert:** If temp reappears (unlink not durable), recovery verifies identity (same inode or digest) → `fsync(final_dir_fd)` MUST succeed (confirm final durability) → unlinks temp again → `fsync(temp_dir_fd)` → marks ACTIVE. If `fsync(final_dir)` fails → stay PENDING, alert. If `fsync(temp_dir)` fails (final durable) → mark ACTIVE, log warning, retry cleanup per §1.6d. Idempotent.
- **EXDEV at runtime:** Simulate `link()` returning EXDEV (despite startup check passing — e.g., remount).
- **Assert:** Log at critical, mark `PUBLICATION_FAILED`, alert `FILESYSTEM_SPLIT`. Do NOT fall back to copy. The file remains at temp; reservation is COMMITTED; operator must intervene.
- **Directory sync ordering:** Instrument to verify `fsync(final_dir)` is called after `link()` and before `unlink(temp)`, and `fsync(temp_dir)` is called after `unlink(temp)`. Assert the ordering is preserved on all paths.

### 6.17 Recovery durability ordering (new, rev 8)
- **Same-inode recovery with fsync failure:** Setup: PENDING asset; temp and final are the same inode (link succeeded but fsync not confirmed). Simulate `fsync(final_dir)` failing during recovery.
- **Assert:** Recovery does NOT unlink temp. Asset remains PENDING. Alert `FSYNC_FAILED`. Temp entry preserved. Identity (inode match) did not authorize skipping the durability step.
- **Same-inode recovery with fsync success:** Same setup, fsync succeeds.
- **Assert:** Recovery unlinks temp, fsyncs temp_dir, marks ACTIVE. The fsync was issued even though the link "already existed."
- **Digest-verified recovery with fsync failure:** Setup: PENDING asset; final exists, temp gone, digest matches. Simulate `fsync(final_dir)` failing.
- **Assert:** Recovery does NOT mark ACTIVE despite digest match. Asset remains PENDING. Alert `FSYNC_FAILED`. Syncing is required for activation; identity alone is insufficient.
- **Digest-verified recovery with fsync success:** Same setup, fsync succeeds.
- **Assert:** Recovery marks ACTIVE. The fsync was issued even though there was no temp entry to remove — it confirms the final link's durability.
- **Ordering verification:** Instrument recovery to record syscall order. Assert on all recovery paths: `fsync(final_dir)` completes successfully before any `unlink(temp)` or `ACTIVE` transition. No path skips the sync.

### 6.18 Stale temp cleanup for ACTIVE assets (new, rev 12)
- **Reappearing temp entry:** Setup: ACTIVE asset; temp entry reappears (simulate by recreating the hard link after a crash). Run the §1.6e cleanup.
- **Assert:** Discovery finds the temp file, maps it to the ACTIVE asset via reservation_id. Inode verification confirms same inode as final. Ownership lock acquired. `unlink(temp)` succeeds, `fsync(temp_dir)` succeeds. Temp entry gone, final file untouched, asset remains ACTIVE.
- **Temp entry with different inode:** Setup: ACTIVE asset; temp path contains a DIFFERENT file (different inode, simulating a bug).
- **Assert:** Inode verification fails → do NOT unlink. Alert `TEMP_INODE_MISMATCH` fires with both inodes. Temp file preserved. Final file untouched. Asset remains ACTIVE.
- **Missing final file:** Setup: ACTIVE asset row exists, but final_path does not exist on disk (simulating data loss).
- **Assert:** Do NOT unlink temp. Alert `ACTIVE_ASSET_MISSING_FILE` fires. Temp preserved for forensics. Asset remains ACTIVE (row unchanged).
- **Failed unlink retry:** Setup: ACTIVE asset with stale temp; simulate `unlink()` failing 5 times (permission error).
- **Assert:** First 4 failures → log warning, retry next cycle. 5th failure → alert `TEMP_CLEANUP_FAILED`. 6th cycle (after fixing permissions) → succeeds, alert clears. Bounded retries work.
- **Failed fsync retry:** Setup: ACTIVE asset with stale temp; `unlink()` succeeds but `fsync(temp_dir)` fails repeatedly.
- **Assert:** Temp entry may reappear; cleanup retries. After 5 fsync failures → alert. Asset remains ACTIVE throughout (final was already durable). No data loss.
- **PENDING exclusion:** Setup: PENDING asset with temp file. Run §1.6e cleanup.
- **Assert:** Skipped (not ACTIVE). The PENDING recovery path (§1.6a) handles it, not §1.6e. No interference between the two mechanisms.
- **Periodic execution:** Assert the cleanup runs on startup (after PENDING recovery) and every 15 minutes via the maintenance job. A stale temp entry created between runs is cleaned within 15 minutes.

### 6.19 Persistent fsync-retry state (new, rev 13)
- **Setup:** ACTIVE asset with stale temp entry. Cleanup runs: `unlink()` succeeds, `fsync(temp_dir)` fails (simulate EIO). Temp entry does NOT reappear (remains absent).
- **Assert:** DB shows `temp_cleanup_fsync_pending = TRUE`, `temp_cleanup_fsync_attempts = 1`, `last_attempt_at` set. Asset remains ACTIVE.
- **Next cycle (temp still absent):** Run cleanup again. The file-listing discovery finds nothing (temp absent).
- **Assert:** DB query finds `temp_cleanup_fsync_pending = TRUE`. Cleanup retries `fsync(temp_dir_fd)` (on the directory, not the file). If succeeds → flag cleared, attempts reset to 0. The retry occurred despite temp absence.
- **Persistent failures:** Simulate 5 consecutive fsync failures with temp absent throughout.
- **Assert:** Attempts increment to 5. Alert `TEMP_CLEANUP_FAILED` fires. The retry state survived across cycles without the temp file.
- **Restart survival:** After 2 failed attempts, simulate process restart (clear in-memory state). Run cleanup.
- **Assert:** DB still shows `pending = TRUE`, `attempts = 2`. Retry continues from attempt 3, not from 0. State survived the restart.
- **Recovery:** After alert, simulate fsync succeeding on attempt 6.
- **Assert:** Flag cleared, attempts reset. Alert clears. No manual intervention needed for transient failures.

### 6.20 Write-ahead marker crash injection (new, rev 14)
- **Crash after unlink, before marker write (old gap):** This test verifies the rev-14 fix. Setup: ACTIVE asset with temp entry. Begin cleanup: marker written (step 2), `unlink()` succeeds. Simulate crash BEFORE the DB marker update would have occurred in the old protocol (i.e., verify the new protocol writes the marker BEFORE unlink).
- **Assert:** After restart, DB shows `temp_cleanup_fsync_pending = TRUE` (marker was written before unlink). Temp entry is absent. Cleanup cycle discovers the marker via DB query (not file listing) → retries `fsync(temp_dir)` → on success clears marker. The retry occurred despite temp absence and despite the crash happening after unlink.
- **Crash after marker, before unlink:** Setup: marker written, then crash before `unlink()`.
- **Assert:** After restart, marker is set, temp file exists. Cleanup acquires lock, verifies inode, performs unlink + fsync → clears marker. No duplicate work, no lost state.
- **Crash after fsync, before marker clear:** Setup: unlink and fsync succeed, then crash before the clear UPDATE.
- **Assert:** After restart, marker is still set (clear didn't commit). Cleanup retries fsync (idempotent, harmless) → succeeds → clears marker. No data loss, no stuck state.
- **DB failure on marker write:** Simulate DB error during step 2 (marker write).
- **Assert:** Cleanup aborts BEFORE unlink. No filesystem mutation occurs without the durable marker. Lock released. Retry next cycle. The invariant "no unlink without marker" holds.
- **DB failure on marker clear:** Simulate DB error during the clear UPDATE (after successful fsync).
- **Assert:** Marker remains set. Next cycle retries fsync (succeeds again, idempotent) → attempts clear again. Eventually succeeds. No lost retry state, no premature clearing.
- **Alert resolution:** Setup: 5 fsync failures → alert fires. Then fsync succeeds on 6th attempt.
- **Assert:** Marker cleared, attempts reset to 0. Alert clears automatically (per §1.6e alert resolution rule). The alert does not require manual acknowledgment to clear — successful fsync is the resolution condition.

### 6.21 Retry accounting (new, rev 15)
- **Duplicate processing in one cycle:** Setup: ACTIVE asset with temp entry; marker not yet set. Cleanup cycle runs Pass 1: processes the temp file, `unlink()` succeeds, `fsync()` fails → marker set (attempts=1). Pass 2 queries DB and finds the same reservation with pending=TRUE.
- **Assert:** Pass 2 skips the reservation (already in `processed` set). The fsync is NOT retried in the same cycle. Attempts remains 1 (not incremented to 2). No premature alert. The retry occurs on the NEXT cycle, not the same one.
- **Counter preservation on rediscovery:** Setup: reservation with `pending=TRUE`, `attempts=3` (from prior failures). Temp file reappears (unlink not durable). Cleanup cycle discovers via file listing.
- **Assert:** Marker write never touches counters (rev 19) → attempts remains 3. The existing failure history is preserved. After the retry fsync fails → attempts becomes 4. After 5th failure → alert fires correctly (not prematurely due to reset).
- **Counter preservation on new obligation (rev 20):** Setup: reservation with no marker (`pending=FALSE`), `unlink_attempts=2`, `fsync_attempts=1` (residual from a prior incomplete cleanup — should not happen normally, but test the logic). New temp file appears.
- **Assert:** Marker write sets `pending=TRUE` but does NOT modify either counter. `unlink_attempts` remains 2, `fsync_attempts` remains 1. **Rev 19 rule: marker initialization never resets counters, regardless of previous marker state.** The counters change only on operation success/failure, not on marker creation.
- **Attempts increment only on fsync failure:** Setup: pending marker with attempts=2. Cycle runs but lock acquisition fails (another process holds it).
- **Assert:** Attempts remains 2 (not incremented). Lock failure is not an fsync failure. Next cycle retries.

### 6.22 Unlink failure counting (new, rev 16)
- **Five consecutive unlink failures:** Setup: ACTIVE asset with temp entry. Simulate `unlink()` failing with EACCES 5 times (fsync never reached).
- **Assert:** After each failure, `temp_cleanup_unlink_attempts` increments (1, 2, 3, 4, 5). `temp_cleanup_fsync_attempts` remains 0 (fsync never attempted). After 5th failure → alert `TEMP_CLEANUP_FAILED` with `failure_type='unlink'`.
- **Restart persistence:** After 3 unlink failures, simulate restart.
- **Assert:** DB shows `unlink_attempts=3`, `pending=TRUE`. Next cycle continues from 3 (not reset). The counter survived the restart.
- **Successful recovery:** After 3 failures, fix permissions. Next cycle: `unlink()` succeeds → `unlink_attempts` reset to 0. Then `fsync()` succeeds → marker cleared, `fsync_attempts` reset to 0.
- **Assert:** Both counters reset independently on their respective successes. A successful unlink does not reset the fsync counter (and vice versa).
- **Independent counters:** Setup: 2 unlink failures, then unlink succeeds, then 2 fsync failures.
- **Assert:** `unlink_attempts=0` (reset on success), `fsync_attempts=2`. The counters track independently. No alert fires (neither reached 5).

### 6.23 Independent alert lifecycle (new, rev 17)
- **Setup:** ACTIVE asset with temp entry. Simulate `unlink()` failing 5 times.
- **Assert:** After 5th failure, `temp_cleanup_unlink_attempts=5`, alert `TEMP_CLEANUP_FAILED` fires with `failure_type='unlink'`. `temp_cleanup_fsync_attempts=0` (fsync never attempted).
- **Action:** Fix the unlink issue. Next cycle: `unlink()` succeeds → `unlink_attempts` reset to 0.
- **Assert:** Unlink alert clears (counter < 5). The alert resolution is tied to unlink success, not fsync.
- **Action:** Now simulate `fsync()` failing 5 times.
- **Assert:** `temp_cleanup_fsync_attempts` increments to 5. Alert `TEMP_CLEANUP_FAILED` fires with `failure_type='fsync'`. The unlink alert REMAINS CLEARED (unlink_attempts=0). Only the fsync alert is active. The two alerts are independent.
- **Action:** Fix fsync. Next cycle: `fsync()` succeeds.
- **Assert:** `fsync_attempts` reset to 0, marker cleared. Fsync alert clears. Both alerts now inactive.
- **No cross-contamination:** Throughout the sequence, verify that unlink successes never affect the fsync counter and vice versa. An operation's recovery clears only its own alert.

### 6.24 Counter isolation (new, rev 18)
- **Setup:** Reservation with `temp_cleanup_unlink_attempts=3` (from prior unlink failures), `temp_cleanup_fsync_attempts=0`. Temp file exists. Cleanup runs: `unlink()` succeeds, `fsync()` succeeds.
- **Assert:** After unlink success → `unlink_attempts` reset to 0. After fsync success → `fsync_attempts` reset to 0 (was already 0), marker cleared. **The fsync success did NOT affect the unlink counter** (it was already reset by the unlink success, not by the fsync).
- **Setup:** Reservation with `unlink_attempts=3`, `fsync_attempts=0`. Temp file is absent (ENOENT). Cleanup runs: skips unlink (ENOENT), `fsync()` succeeds.
- **Assert:** `unlink_attempts` reset to 0 (ENOENT satisfies the obligation). `fsync_attempts` reset to 0. Marker cleared. The fsync success did not "clear" the unlink counter — the ENOENT observation did.
- **Setup:** Reservation with `unlink_attempts=3`, `fsync_attempts=2`. Cleanup runs: `unlink()` succeeds, `fsync()` fails.
- **Assert:** After unlink → `unlink_attempts=0`. After fsync failure → `fsync_attempts=3` (incremented from 2). Marker remains set. **The successful unlink did NOT reset the fsync counter.** The failed fsync did NOT affect the (now-zero) unlink counter. Counters are fully independent.

### 6.25 Marker and counter consistency (new, rev 19)
- **New marker preserves counters:** Setup: reservation with `unlink_attempts=3`, `fsync_attempts=2`, `pending=FALSE` (simulating a state where prior cleanup left counters non-zero). Start new cleanup → marker write executes.
- **Assert:** After marker write, `unlink_attempts` still 3, `fsync_attempts` still 2, `pending=TRUE`. The marker write did NOT reset either counter. Counters are only modified by operation successes/failures, never by marker initialization.
- **Pending recovery with absent temp:** Setup: `pending=TRUE`, `unlink_attempts=3`, `fsync_attempts=1`. Temp file absent. Recovery runs.
- **Assert:** Recovery observes absence → resets `unlink_attempts` to 0 (ENOENT rule). Then `fsync()` succeeds → `fsync_attempts` reset to 0, marker cleared. Final: both counters 0, pending FALSE. The absence reset the unlink counter; the fsync success reset only the fsync counter.
- **Fsync failure after absence reset:** Setup: `pending=TRUE`, `unlink_attempts=3`. Temp absent. Recovery: resets unlink to 0, then `fsync()` fails.
- **Assert:** `unlink_attempts=0` (reset by absence), `fsync_attempts` incremented (from prior value). Marker remains set. The fsync failure did NOT re-increment the unlink counter.
- **Restart preserves history:** Setup: `pending=TRUE`, `unlink_attempts=4`. Crash. Restart. Recovery finds marker.
- **Assert:** `unlink_attempts` still 4 (not reset by marker rewrite, not reset by restart). The history survives until unlink succeeds or ENOENT is observed.

### 6.26 Alert lifecycle regression (new, rev 21)
- **Setup:** ACTIVE asset. Simulate unlink failures.
- **Incident opens:** After 5 failures, assert alert fires with `failure_type='unlink'`, `incident_id` generated (UUID). `unlink_attempts=5`.
- **Re-fire:** After 10 failures, assert alert re-fires with SAME `incident_id` (same incident). After 15 failures, assert escalation to critical with SAME `incident_id`.
- **Resolution:** Fix issue. Unlink succeeds. Assert `unlink_attempts=0`. Both warning and critical alerts clear. Incident closed.
- **Recurrence:** Later, unlink fails 5 times again. Assert NEW alert fires with DIFFERENT `incident_id`. NOT escalated (starts at warning). The prior escalation does not carry over.
- **Independent types:** During the second unlink incident, simulate fsync failures reaching 5. Assert fsync alert fires with `failure_type='fsync'` and its own `incident_id`. The unlink incident is unaffected. Two independent open incidents.
- **Manual ack does not resolve:** Acknowledge the unlink alert (operator marks seen). Assert incident remains open (`unlink_attempts` still >= 5). The alert is suppressed for notifications but NOT resolved. Only a successful unlink resolves it.

### 6.27 Incident persistence crash recovery (new, rev 22)
- **Crash after success, before resolution:** Setup: `unlink_attempts=5`, incident open. Cleanup: `unlink()` succeeds. Simulate crash BEFORE the transaction commits (counter reset + incident resolution).
- **Assert:** After restart, DB shows `unlink_attempts=5` (not reset, txn rolled back), incident still `status='open'`. Recovery retries: `unlink()` succeeds again (idempotent, file already gone → ENOENT → treated as success) → transaction commits: counter reset, incident resolved. No stale open incident.
- **Crash after incident open, before alert delivery:** Setup: counter reaches 5, incident INSERT commits, then crash before alert system sends notification.
- **Assert:** After restart, incident exists with `status='open'` and outbox event exists with `status='pending'`. Delivery worker claims the pending event and sends. The incident was not lost. Receiver deduplicates by `delivery_event_id` (not `incident_id`).
- **Stale incident reconciliation:** Setup: manually set incident to `status='open'` with counter at 3 (simulating a crash where counter reset but incident didn't).
- **Assert:** Startup scan finds open incident with counter < 5 → resolves it: `status='resolved'`, `resolved_at` set. Logs `STALE_INCIDENT_RESOLVED` at warning. The resolved incident cannot remain active.
- **Recurrence UUID uniqueness:** Setup: incident U1 resolved. New failures reach 5.
- **Assert:** New incident U2 inserted with different UUID. Old U1 remains with `status='resolved'`. UNIQUE constraint allows this (only enforces uniqueness for open/escalated). No conflict, no accidental reopen of U1.
- **Atomic counter+incident:** Simulate DB failure during the transaction that increments counter to 5 and inserts incident.
- **Assert:** Transaction rolls back. Counter remains at 4, no incident row exists. The two are always consistent — never a counter at 5 without an incident, never an incident without the counter.

### 6.28 Incident recurrence schema regression (new, rev 23)
- **Setup:** Reservation R1. First unlink incident: 5 failures → incident U1 opens (`status='open'`). Unlink succeeds → U1 resolved (`status='resolved'`).
- **Assert:** DB contains one row: U1 with `status='resolved'`. No constraint violation.
- **Action:** Later, unlink fails 5 times again.
- **Assert:** New incident U2 inserts successfully with different UUID. DB now contains TWO rows with `(R1, 'unlink')`: U1 (resolved) and U2 (open). The partial unique index allows this because U1 is resolved (excluded from the index).
- **Action:** Attempt to open a third incident while U2 is still open (simulate a bug trying to double-open).
- **Assert:** INSERT fails with unique violation on `temp_cleanup_incidents_open_unique`. Only one open/escalated incident per (reservation, type) can exist. The constraint is enforced.
- **Action:** Resolve U2. Open a third incident U3.
- **Assert:** U3 inserts successfully. DB contains three resolved/open rows for (R1, 'unlink'): U1 (resolved), U2 (resolved), U3 (open). Audit history preserved; active constraint maintained.

### 6.29 Outbox delivery regression (new, rev 25)
- **Re-fire generates new event:** Setup: incident open, counter at 5, outbox has event E1 (`fire_count=5`, `status='sent'`). Counter reaches 10.
- **Assert:** New outbox event E2 created with different `delivery_event_id`, `fire_count=10`, same `incident_id`. E1 remains `status='sent'` (not modified, not overwritten). The receiver gets a new notification for E2 (not suppressed as duplicate of E1).
- **Crash retry deduplicated:** Setup: outbox event E1 `status='pending'`. Worker claims E1, sends to receiver, crashes before marking 'sent'.
- **Assert:** On restart, worker reclaims E1 (stale claim) and re-sends. Receiver gets same `delivery_event_id` → deduplicates → operator paged once, not twice.
- **Concurrent workers:** Setup: two workers, one pending event E1.
- **Assert:** Only one worker successfully claims E1 (`FOR UPDATE SKIP LOCKED`). The other gets no row (skipped). E1 sent exactly once. No concurrent duplicate.
- **Event per firing uniqueness:** Simulate txn retry causing duplicate INSERT for `fire_count=10`.
- **Assert:** Second INSERT fails on `UNIQUE(incident_id, fire_count)`. Only one event per firing exists. No duplicate notifications.

### 6.30 Backoff and fencing regression (new, rev 26)
- **Backoff enforced:** Setup: outbox event E1, first delivery fails. Assert: `next_attempt_at` = now + 1 minute. Claim query immediately after → E1 NOT selected (next_attempt_at in future). After 1 minute (simulate time advance) → E1 eligible again.
- **Backoff escalation:** Fail again. Assert: `next_attempt_at` = now + 5 minutes. Fail again → +15 minutes. The delays increase per the schedule.
- **Initial event immediate:** New event E2 created. Assert: `next_attempt_at` <= now (default). Claim query selects E2 immediately. No artificial delay for first delivery.
- **Stale claim fencing:** Setup: worker A claims E1 (token T_A). Worker A stalls. After 5 min, worker B reclaims E1 (token T_B). Worker A wakes up, tries to mark 'sent' with T_A.
- **Assert:** UPDATE with `claim_token=T_A` affects 0 rows (token mismatch). Worker A's update is rejected. Worker B owns the event. E1 not marked 'sent' by the stale worker.
- **Fenced retry:** Worker B's send fails. Worker B updates with T_B → succeeds, sets `next_attempt_at`. Worker A tries retry update with T_A → 0 rows. Only the current claimant modifies state.
- **Crash during send:** Worker claims E1 (token T), sends to receiver, crashes before confirm. After 5 min, worker B reclaims (new token). Re-sends. Receiver deduplicates by `delivery_event_id` → single notification. Worker B confirms with its token → 'sent'.
