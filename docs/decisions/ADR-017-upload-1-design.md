# ADR-017 UPLOAD-1 Design: Upload Path Rework

**Status:** DRAFT rev 7 — fixes schema, quota fn, conversion SQL, fence consistency
**Date:** 2026-10-18
**Scope:** `POST /worlds/:id/media` rework per ADR-017 §4.4

## 1. Objective

Replace the current direct-to-filesystem upload (`src/modules/world/http/world.routes.ts:546-582`) with the ADR-017 compliant failure-atomic upload path that integrates Phase-1 reservation, Phase-2 write, and registry publication.

## 2. Current Behavior (Pre-ADR-017)

The existing route:
1. Validates mimetype against allowlist (not magic bytes)
2. Writes directly to `deps.mediaStoragePath` with UUID filename
3. Returns 201 with `/media/{filename}` URL
4. No reservation, no quota check, no registry row, no publication phases

This bypasses every ADR-017 guarantee: no quota enforcement, no crash safety, no reconciliation visibility.

## 3. New Upload Flow (§4.4 Failure-Atomicity Table)

```
0. Auth: validate session, world ownership → 401/403/404
1. Allowance: Create staging allowance (DB txn, L1) → 503 FENCE_ACTIVE / BACKFILL_IN_PROGRESS / 507 QUOTA_EXCEEDED
2. Stream: Multipart stream to /data/media/.staging/{allowance_id}.tmp (10 MB cap) → 413 if exceeded
3. Validate: Magic bytes from streamed data → 415 on invalid (cancel allowance, delete staged file)
4. Measure: fstat() staged file → actual_bytes
5. Convert: Atomic allowance → reservation (DB txn, L1) → 507 QUOTA_EXCEEDED / 503 FENCE_ACTIVE
6. Phase-2: Move staged file to .tmp/{reservation_id}.part; Phase2Writer writes (if chunked)
7. Fsync: file → rename to final → fsync directory
8. Phase-A: commitReservationToRegistry() → asset PENDING + reservation COMMITTED
9. Phase-B/C: publication.service handles link + activation
10. Return 201 with registry URL (only after ACTIVE)
```

### 3.1 Staging Allowance Lifecycle (rev 5: complete specification)

**Problem:** `reserveStorage()` needs an exact byte count, but multipart streams don't provide trustworthy sizes. Streaming before reservation allows unaccounted disk usage.

**Solution:** Allowance-first, stream-second. No bytes are accepted until quota is reserved.

#### Step 0: Create staging allowance (BEFORE any file bytes)

```
POST /worlds/:id/media initiates:
  → Validate auth, world ownership (401/403/404 as before)
  → Validate magic bytes from first 12 bytes? NO — can't read bytes yet.
  
  Actually: Magic bytes validation requires reading the stream. 
  Revised order:
  1. Auth checks (no DB writes)
  2. Create staging allowance (DB transaction, see below)
  3. Stream with multipart cap (10 MB)
  4. Validate magic bytes from streamed data
  5. fstat() for exact size
  6. Convert allowance → reservation (atomic)
```

**Allowance creation transaction:**
```sql
BEGIN;
-- L1: Serialize against fence, backfill, other uploads
SELECT pg_advisory_xact_lock(hashtext('media_global'));

-- Check fence (fail-closed)
SELECT active FROM system_maintenance WHERE id = 1;
-- If active → ROLLBACK, return 503 FENCE_ACTIVE

-- Check backfill freeze
SELECT COUNT(*) FROM backfill_runs WHERE status = 'in_progress';
-- If > 0 → ROLLBACK, return 503 BACKFILL_IN_PROGRESS

-- Check quota INCLUDING existing allowances
-- quota_used_bytes() counts: assets + reservations + active allowances
SELECT quota_used_bytes($world_id);
-- If quota_used + 10485760 > quota_limit → ROLLBACK, 507 QUOTA_EXCEEDED

-- Create the allowance
INSERT INTO staging_allowances 
  (allowance_id, world_id, max_bytes, state, expires_at)
VALUES 
  (gen_random_uuid(), $world_id, 10485760, 'active', now() + interval '2 minutes')
RETURNING allowance_id;
COMMIT;
```

**Migration 018 schema:**
```sql
CREATE TABLE staging_allowances (
  allowance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  max_bytes BIGINT NOT NULL CHECK (max_bytes > 0 AND max_bytes <= 10485760),
  state TEXT NOT NULL 
    CHECK (state IN ('active', 'expiring', 'converting', 'expired', 'cancelled'))
    DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reservation_id UUID REFERENCES storage_reservations(reservation_id),
  -- State machine constraints:
  -- 'active' → 'expiring' (expiry detected)
  -- 'active' → 'converting' (conversion started)
  -- 'active' → 'cancelled' (user cancelled)
  -- 'expiring' → 'expired' (cleanup deleted file)
  -- 'expiring' → 'converting' (writer won race)
  -- 'converting' → 'cancelled' (conversion committed)
  CONSTRAINT chk_expiring_has_expiry CHECK (
    (state != 'expiring') OR (expires_at <= now())
  )
);
CREATE INDEX idx_staging_allowances_world_state 
  ON staging_allowances(world_id, state) WHERE state IN ('active', 'expiring');
CREATE INDEX idx_staging_allowances_expiry 
  ON staging_allowances(expires_at) WHERE state = 'active';
CREATE INDEX idx_staging_allowances_expiring 
  ON staging_allowances(allowance_id) WHERE state = 'expiring';
```

**Migration 019: Update quota_used_bytes() (rev 7: authoritative definition)**
```sql
CREATE OR REPLACE FUNCTION quota_used_bytes(p_world_id UUID)
RETURNS BIGINT AS $$
  SELECT
    COALESCE((SELECT SUM(size_bytes) FROM world_media_assets
      WHERE world_id = p_world_id
        AND lifecycle IN ('active', 'pending_deletion')
        AND file_confirmed_present = true), 0)
    +
    COALESCE((SELECT SUM(size_bytes) FROM storage_reservations
      WHERE world_id = p_world_id
        AND state IN ('RESERVED', 'WRITING')), 0)
    +
    -- Staging allowances: 'active' and 'expiring' both count.
    -- 'expiring' means the file may still exist on disk (cleanup deferred).
    -- 'converting' does NOT count (reservation will be counted instead).
    -- 'expired' and 'cancelled' do NOT count (file deleted or converted).
    -- No expires_at check: state machine is authoritative, not the timestamp.
    COALESCE((SELECT SUM(max_bytes) FROM staging_allowances
      WHERE world_id = p_world_id
        AND state IN ('active', 'expiring')), 0);
$$ LANGUAGE SQL STABLE;
```

**This is the authoritative definition.** It matches the state machine:
- `active` → counted (normal)
- `expiring` → counted (file may still exist, cleanup deferred)
- `converting` → not counted (atomic handoff to reservation)
- `expired`, `cancelled` → not counted (terminal states)

**Which states count (rev 6: fixes accounting gap):**
- `'active'` AND `expires_at > now()` → COUNTED (normal case)
- `'active'` AND `expires_at <= now()` → COUNTED (expired but file may still exist!)
- `'expiring'` → COUNTED (cleanup is attempting to reclaim, but file still on disk)
- `'converting'` → NOT counted (in atomic transition, reservation will be counted)
- `'expired'` → NOT counted (file deleted, accounting released)
- `'cancelled'` → NOT counted (converted to reservation, which is counted)

**New state: `'expiring'`**

The accounting gap (reviewer blocker 1): An expired allowance stops counting, but the file may still occupy disk (cleanup skipped it because writer holds the lock). This allows over-commit.

**Fix:** Expiry does NOT release accounting. New lifecycle:
```
'active' → (expires_at passes) → 'expiring' (still counted!)
  → cleanup acquires file lock → deletes file → 'expired' (not counted)
  → cleanup cannot acquire lock (writer active) → remains 'expiring' (still counted)
  → writer finishes, releases lock → next cleanup cycle deletes → 'expired'
```

**State transition table:**
| From | To | Trigger | Accounting |
|------|----|---------|------------|
| `active` | `expiring` | `expires_at < now()` (detected by cleanup job or conversion attempt) | COUNTED (both) |
| `expiring` | `expired` | Cleanup acquires `LOCK_EX`, deletes file | NOT counted |
| `expiring` | `active` | Writer completes conversion before cleanup (race won by writer) | COUNTED |
| `active` | `converting` | Conversion transaction starts | NOT counted (reservation will count) |
| `converting` | `cancelled` | Conversion commits | NOT counted |
| `active` | `cancelled` | User cancels upload | NOT counted (file deleted synchronously) |

**quota_used_bytes() (rev 6):**
```sql
COALESCE((SELECT SUM(max_bytes) FROM staging_allowances
  WHERE world_id = p_world_id
    AND state IN ('active', 'expiring')), 0)
-- Note: No expires_at check! 'expiring' counts even after expiry.
-- 'expired' and 'cancelled' are excluded by state.
```

**Invariant:** Bytes on disk are always counted until the file is deleted. No gap.

#### Step 1: Stream to staging file

- Path: `/data/media/.staging/{allowance_id}.tmp`
- Multipart enforces 10 MB cap (matches `max_bytes`)
- If stream exceeds 10 MB → multipart aborts → 413, allowance remains (expires in 2 min, cleanup job removes file)

#### Step 2: Validate and measure

1. Read first 12 bytes → validate magic bytes → 415 if invalid (delete staged file, cancel allowance)
2. `fstat()` staged file → exact `actual_bytes`

#### Step 3: Atomic allowance → reservation conversion

**Authoritative conversion transaction (rev 7):**

```sql
BEGIN;
-- L1: Serialize against cleanup job, fence, backfill, other conversions
SELECT pg_advisory_xact_lock(hashtext('media_global'));

-- Step 1: Claim the allowance (handles both 'active' and 'expiring')
-- This is the mutual exclusion point vs cleanup job.
UPDATE staging_allowances 
SET state = 'converting',
    reservation_id = NULL  -- Will be set after reservation created
WHERE allowance_id = $1 
  AND state IN ('active', 'expiring');
-- If 0 rows affected:
--   → Allowance is 'expired', 'cancelled', or 'converting' (another conversion in progress)
--   → ROLLBACK, delete staged file if exists, return 500 STAGING_EXPIRED
-- The UPDATE is atomic: cleanup job cannot mark it 'expired' after we claim it,
-- because cleanup also does UPDATE ... WHERE state IN ('active', 'expiring').

-- Step 2: Re-check fence and backfill (could have activated during streaming)
SELECT active FROM system_maintenance WHERE id = 1;
-- If active → ROLLBACK
--   → Allowance remains 'converting' (not 'active', not counted)
--   → Cleanup job will see 'converting' with old timestamp → mark 'expired' after timeout → delete file
--   → Return 503 FENCE_ACTIVE

SELECT COUNT(*) FROM backfill_runs WHERE status = 'in_progress';
-- If > 0 → ROLLBACK (same as fence), return 503 BACKFILL_IN_PROGRESS

-- Step 3: Create the reservation (quota checked with allowance still 'converting')
-- reserveStorage() logic:
--   - Checks quota_used_bytes() which does NOT count 'converting' allowances
--   - INSERTs into storage_reservations (which IS counted)
--   - If quota exceeded → ROLLBACK → allowance stays 'converting' → cleanup handles
--   - Returns reservation_id

-- Step 4: Link allowance to reservation, mark cancelled
UPDATE staging_allowances 
SET state = 'cancelled',
    reservation_id = $reservation_id
WHERE allowance_id = $1;
-- 'cancelled' is terminal, not counted. The reservation is now counted.

COMMIT;
-- L1 released. Quota accounting: allowance (not counted) → reservation (counted). Atomic.
```

**Mutual exclusion with cleanup job:**

Both conversion and cleanup use the same pattern:
```sql
UPDATE staging_allowances SET state = $new_state
WHERE allowance_id = $1 AND state IN ('active', 'expiring');
```

- **Conversion** sets `state='converting'`
- **Cleanup** sets `state='expired'` (after deleting file)

PostgreSQL row-level locking ensures exactly one wins:
1. Conversion's UPDATE acquires row lock → cleanup's UPDATE blocks
2. Conversion commits → row is 'converting' → cleanup's WHERE clause no longer matches → 0 rows affected → cleanup skips
3. OR: Cleanup's UPDATE acquires lock first → row becomes 'expired' → conversion's WHERE no longer matches → 0 rows → conversion aborts with STAGING_EXPIRED

**Invariant:** Exactly one of (conversion succeeds) or (cleanup deletes) happens. Never both, never neither (the row always ends in a terminal state).

**Filesystem coordination:**
- Conversion holds the DB row lock during the transaction, but does NOT hold the file lock.
- After COMMIT, conversion moves the file (rename). This is atomic at the filesystem level.
- Cleanup acquires `LOCK_EX|LOCK_NB` on the file BEFORE the DB UPDATE. If the file is locked (writer active), cleanup skips the DB update entirely.
- Order for cleanup: (1) Try file lock, (2) If acquired, DB UPDATE to 'expired', (3) Delete file, (4) Release lock.
- Order for conversion: (1) DB UPDATE to 'converting', (2) COMMIT, (3) Rename file (no lock needed, writer already finished streaming).

**Transaction boundaries:**
- Allowance creation: Single transaction (L1 held for short duration)
- Streaming: NO transaction (filesystem only, allowance row exists)
- Conversion: Single transaction (L1 held, allowance→reservation atomic)

**Lock order:** L1 (`media_global`) → L2 (`media_quota:{world_id}`) → world row `FOR UPDATE`. Same as RES-1a/QUOTA-1. Consistent global ordering prevents deadlock.

**Concurrency guarantee:** Two simultaneous uploads:
1. Upload A creates allowance (10 MB counted in quota)
2. Upload B creates allowance (10 MB counted in quota) 
3. If A+B+existing > quota → B's allowance creation fails with 507 (quota check includes A's allowance)
4. Aggregate staging cannot exceed quota.

#### Step 4: Expiry during streaming (rev 6: accounting preserved)

**Race:** Allowance expires (2 min) while file is still streaming.

**Protocol:**
1. Cleanup job runs every 5 minutes.
2. For each `staging_allowances` WHERE `state='active'` AND `expires_at < now()`:
   a. `UPDATE staging_allowances SET state='expiring' WHERE allowance_id=$1 AND state='active'`
      -- Now counted as 'expiring' (still in quota)
   b. Try to acquire exclusive lock: `flock({allowance_id}.tmp, LOCK_EX|LOCK_NB)`
   c. If lock acquired → no active writer:
      - Delete file
      - `UPDATE staging_allowances SET state='expired' WHERE allowance_id=$1`
      - Log incident (accounting released)
   d. If lock fails (EBUSY) → writer is active:
      - Leave as `'expiring'` (STILL COUNTED in quota)
      - Log: "deferred cleanup, writer active"
      - Next cleanup cycle retries
3. At conversion time:
   - If allowance is `state='expiring'` → writer won the race (still holds file lock)
     → Allow conversion to proceed (UPDATE to 'converting')
     → Accounting transitions atomically (expiring→converting, then reservation created)
   - If allowance is `state='expired'` → cleanup won → ROLLBACK → 500 `STAGING_EXPIRED`

**Accounting invariant:** The 10 MB is counted from allowance creation until either:
- File deleted + state='expired', OR
- Converted to reservation (allowance→'cancelled', reservation counted)

There is no point where bytes exist on disk but are uncounted.

#### Step 5: Crash recovery

| Crash point | Recovery |
|-------------|----------|
| During allowance creation (before COMMIT) | Transaction rolls back, no allowance row. No cleanup needed. |
| During streaming (after allowance COMMIT) | Allowance expires in 2 min. Cleanup job finds file without live allowance (via file lock check), deletes it, marks allowance `expired`. |
| During conversion (before COMMIT) | Transaction rolls back. Allowance remains `active` (or `converting` if crash after UPDATE). Cleanup job handles. Staged file remains; cleanup deletes it. |
| After conversion COMMIT, before file move | Reservation exists, allowance is `cancelled`. Staged file exists. See "Orphan Sweep" below. |
| During file move | Filesystem atomicity: `rename()` is atomic. Either the file is at old path or new path, never both/neither. |

#### Step 5b: Orphan Staging File Sweep (rev 6: addresses blocker 3)

**Problem:** After conversion commits, the allowance is `cancelled`. If the process crashes before moving the file, the staged file exists but the cleanup algorithm (which only checks `active`/`expiring` allowances) won't find it.

**Solution:** Periodic orphan sweep (runs with the cleanup job, every 5 min):

```
For each file in /data/media/.staging/:
  1. Extract allowance_id from filename ({allowance_id}.tmp)
  2. SELECT state FROM staging_allowances WHERE allowance_id = $1
  3. If no row → orphan (allowance deleted or never created):
     a. Try LOCK_EX|LOCK_NB on the file
     b. If acquired → delete file, log 'staging_orphan_no_allowance'
     c. If locked → skip (writer may be active, will retry next cycle)
  4. If state = 'cancelled':
     a. Check if reservation exists for this upload
        (join via world_id + created_at window, or store reservation_id in allowance)
     b. If reservation exists AND .part file exists → conversion succeeded, staged file is leftover
        → Try LOCK_EX|LOCK_NB → delete if acquired, log 'staging_orphan_cancelled'
     c. If no reservation → conversion failed before COMMIT → treat as orphan, delete
  5. If state = 'expired':
     a. File should already be deleted (cleanup did it when marking expired)
     b. If file still exists → previous cleanup crashed mid-delete → retry delete
  6. If state IN ('active', 'expiring', 'converting'):
     a. Do NOT delete (handled by the main cleanup algorithm above)
```

**Schema addition:** Add `reservation_id` to `staging_allowances` (nullable, set during conversion):
```sql
ALTER TABLE staging_allowances ADD COLUMN reservation_id UUID REFERENCES storage_reservations(reservation_id);
```
This allows the orphan sweep to correlate staged files with reservations.

**Safety:** The sweep NEVER deletes a file without first acquiring `LOCK_EX|LOCK_NB`. If a writer holds the lock (during streaming or conversion), the sweep skips. No race.

#### Step 6: Incident logging

All staging lifecycle events logged to `temp_cleanup_incidents`:
- `staging_allowance_created`: allowance_id, world_id, max_bytes
- `staging_allowance_expired`: allowance_id, bytes_wasted
- `staging_file_orphaned`: allowance_id, file_path, bytes_reclaimed
- `staging_conversion_failed`: allowance_id, reason
- `staging_cleanup_failed`: allowance_id, error

**Retry behavior:** Client receives 500 `STAGING_EXPIRED` → retries entire upload (new allowance). Not idempotent (documented in §3.5).

### 3.2 Failure Handling

| Failure Point | Behavior |
|---------------|----------|
| Auth/world ownership | 401/403/404, no allowance created |
| Fence active (at allowance) | 503 FENCE_ACTIVE, no allowance, no stream accepted |
| Backfill freeze (at allowance) | 503 BACKFILL_IN_PROGRESS, no allowance, no stream accepted |
| Quota exceeded (at allowance) | 507 QUOTA_EXCEEDED, no allowance, no stream accepted |
| File too large (multipart) | 413, stream aborted, allowance expires (cleanup job) |
| Magic bytes invalid | 415, staged file deleted, allowance cancelled |
| Quota exceeded (at conversion) | 507 QUOTA_EXCEEDED, staged file deleted, allowance cancelled |
| Fence active (at conversion) | 503 FENCE_ACTIVE, staged file deleted, allowance cancelled |
| Storage full | 507 STORAGE_FULL (from reserveStorage during conversion) |
| Allowance expired during stream | 500 STAGING_EXPIRED, staged file deleted |
| Phase-2 write fails | Reservation expires (RES-1c reaps), temp cleaned |
| Phase-A commit fails | Reservation remains, expires via RES-1c |
| Row insert fails after file written | Orphan compensation: synchronous delete + 500 |
| Phase-A fails | Reservation remains RESERVED; RES-1c reaps after expiry; temp `.part` cleaned by stale-temp cleanup (§1.6e) |
| Publication fails after Phase-A | Asset remains PENDING; reconciliation flags for operator; temp `.part` cleaned by §1.6e |
| Compensation itself fails | Alert incident in `temp_cleanup_incidents`; operator intervention required |
| Staging file orphaned (crash during staging) | Staging allowances expire after 2 min; cleanup job scans `/data/media/.staging/` for files without active allowances and deletes them; incidents logged |

### 3.2 Magic Bytes Validation

Replace extension-based mimetype check with magic bytes:
- JPEG: `FF D8 FF`
- PNG: `89 50 4E 47 0D 0A 1A 0A`
- WebP: `RIFF....WEBP`
- GIF: `GIF87a` or `GIF89a`

Read first 12 bytes, validate before Phase-1. Returns 415 on mismatch.

### 3.3 Backfill Freeze Check (addresses review: race protection)

**Problem:** Checking for `in_progress` backfill, then proceeding, allows a backfill to start between the check and the commit.

**Solution:** The freeze check is performed INSIDE the Phase-1 reservation transaction, under L1 (`pg_advisory_xact_lock(hashtext('media_global'))`).

Per ADR-017 §4.3c, backfill start also acquires L1. The lock ordering guarantees:
- If backfill holds L1, the upload's Phase-1 blocks until backfill completes or releases.
- If upload holds L1 (in Phase-1), backfill start blocks until Phase-1 commits.

The check is not a separate query — it's part of the atomic reservation transaction. No TOCTOU.

### 3.4 Fence Check (addresses review: race protection)

Same pattern: `isFenceActive()` is called INSIDE the Phase-1 transaction (already implemented in `reserve-storage.service.ts:115`). Fence activation also acquires L1 per §4.3d. The lock serializes fence activation against new reservations.

### 3.4 Integration with Existing Slices

- **RES-1a:** `reserveStorage()` for Phase-1 (already implemented)
- **RES-1b:** `Phase2Writer` for chunked writes, `phaseACommit` → `commitReservationToRegistry` for Phase-A
- **QUOTA-1:** `checkFileSizeLimit()`, `quotaUsedBytes()` (via reserveStorage), `commitReservationToRegistry()`
- **FENCE-1:** `isFenceActive()` check (already wired in reserveStorage)

### 3.5 Success Semantics (addresses review)

**201 is returned only after the asset is ACTIVE.**

Full sequence:
1. Phase-1 reservation → Phase-2 write → Phase-A commit (PENDING) → Phase-B link → Phase-C ACTIVE → 201.

**If publication cannot complete after Phase-A commits:**
- Asset remains `PENDING` in registry.
- Reconciliation (RECOV-1) detects PENDING assets with no final file and alerts.
- The upload returns 500 (not 201) — the client knows it didn't succeed.
- Operator resolves via the recovery runbook (OPS-1).
- The reservation is already COMMITTED, so quota is correctly accounted.

**Client retry:** Each retry is a NEW attempt, not idempotent.
- New reservation, new temp file, new asset row (if it gets that far).
- The old PENDING asset (if Phase-A committed) is cleaned by reconciliation.
- The old reservation (if not committed) expires via RES-1c.
- Duplicate assets may exist temporarily; reconciliation resolves.

**No idempotency key:** The design does not provide idempotent retries. If needed, add `Idempotency-Key` header support as a future enhancement (out of scope for UPLOAD-1).

### 3.6 Staging Cleanup Guarantees (addresses review)

**Staging files** (`/data/media/.staging/{allowance_id}.tmp`):

1. **Normal path:** Deleted synchronously after move to `.tmp/{reservation_id}.part`.
2. **Reservation failure:** Deleted synchronously before returning 507.
3. **Process crash during staging:** 
   - The `staging_allowances` row expires after 2 minutes.
   - A cleanup job (runs every 5 min, part of RES-1c's expiry worker) scans `/data/media/.staging/`:
     - For each file, check if a live allowance exists.
     - If no live allowance → delete file, log incident.
   - Incidents are visible in `temp_cleanup_incidents` with `failure_type='staging_orphan'`.
4. **Synchronous deletion fails:** 
   - Log to `temp_cleanup_incidents` immediately.
   - The periodic cleanup job will retry.
   - Alert fires per the incident escalation policy (5/10/15 failures).

**Visibility:** All cleanup actions (success or failure) are logged with `allowance_id`, `world_id`, and `bytes_reclaimed`. Operators can audit via `temp_cleanup_incidents`.

### 3.7 Fence Synchronization Protocol (rev 5: cross-process race closed)

**Problem (reviewer):** Rev 4 says the writer checks the fence then writes. A DB read followed by a filesystem write does not prove fence activation cannot interleave.

**Root cause:** Writer uses `flock(LOCK_SH)` on the .part file. Fence activation uses `pg_advisory_xact_lock()` (L1). These are different primitives — they do not synchronize.

#### The Protocol

**Fence activation MUST acquire file locks:**

```
FENCE ACTIVATION SEQUENCE:
1. Acquire L1: pg_advisory_xact_lock(hashtext('media_global'))
   -- Serializes against other fence operations, backfill, Phase-1

2. Enumerate active writers:
   SELECT reservation_id FROM storage_reservations 
   WHERE state IN ('RESERVED', 'WRITING') AND expires_at > now();
   
3. For EACH active reservation:
   a. Path = /data/media/.tmp/{reservation_id}.part
   b. Acquire LOCK_EX on Path (blocking)
      -- This waits for any writer holding LOCK_SH to finish its chunk
      -- Kernel flock() works cross-process
   c. Hold the LOCK_EX (do not release yet)

4. With all writer locks held (LOCK_EX):
   a. UPDATE storage_reservations SET state = 'ABANDONED' 
      WHERE state IN ('RESERVED', 'WRITING');
   b. UPDATE system_maintenance SET active = true WHERE id = 1;
   c. COMMIT (releases L1)

5. Release all LOCK_EX file locks.

FENCE EFFECTIVE POINT: After step 4c (COMMIT). At this point:
- All reservations are ABANDONED (visible to new transactions)
- The fence flag is set (visible to new transactions)
- No writer holds LOCK_SH (we acquired LOCK_EX on all)
```

**Writer chunk sequence (revised):**
```
1. Acquire LOCK_SH on /data/media/.tmp/{reservation_id}.part (blocking)
2. While holding LOCK_SH:
   a. SELECT state FROM storage_reservations WHERE reservation_id = $1
   b. If state NOT IN ('RESERVED', 'WRITING') → release, throw FENCED_WRITE_REJECTED
   c. SELECT active FROM system_maintenance WHERE id = 1
   d. If active → release, throw FENCE_ACTIVE
   e. Write chunk bytes to file descriptor
   f. fsync (if required by policy)
3. Release LOCK_SH
```

**Why the race is closed:**

| Scenario | Outcome |
|----------|---------|
| Writer holds LOCK_SH, fence activation starts | Fence blocks at step 3b (LOCK_EX waits). Writer completes chunk, releases. Fence proceeds. Writer's NEXT chunk sees ABANDONED → aborts. |
| Fence holds LOCK_EX (step 4), writer starts chunk | Writer blocks at step 1 (LOCK_SH waits for LOCK_EX). Fence completes, releases. Writer acquires LOCK_SH, checks state → ABANDONED → aborts. |
| Writer checks state (active), fence activates, writer writes | IMPOSSIBLE. Fence cannot acquire LOCK_EX while writer holds LOCK_SH. The check and write are atomic w.r.t. fence activation. |

**Deployment topology (rev 6: explicit):**

**Supported:** Single-machine deployment (current Fly.io topology).
- One machine (`83d1299cdd1258`) runs the application.
- Volume `/data` is attached to that machine only.
- All writers are processes on that single machine.
- `flock()` on `/data/media/.tmp/*.part` synchronizes correctly (kernel-level, same filesystem).

**NOT supported (explicitly out of scope):**
- Multi-machine writers on a shared network filesystem (NFS, etc.). `flock()` semantics on NFS are unreliable (may not propagate, may deadlock).
- If the deployment ever scales to multiple machines with shared storage, the fence protocol MUST be redesigned (e.g., using PostgreSQL advisory locks per-file instead of flock).

**Topology invariant:** UPLOAD-1 assumes single-writer-host. This matches the current Fly.io single-machine constraint (ADR-017 §9.2).

**Fence activation failure handling (rev 7: consistent contract):**

```
For EACH active reservation:
  Path = /data/media/.tmp/{reservation_id}.part
  
  Case 1: File does not exist
    → This is SAFE to skip. Reason: If the file doesn't exist, no writer
      is currently holding LOCK_SH on it (writers create the file before
      acquiring the lock). The reservation exists in DB but has no active
      filesystem writer. Invalidating the DB reservation is sufficient.
    → Log at DEBUG level, continue.
    → The DB invalidation (step 4a) will still mark this reservation ABANDONED.
  
  Case 2: flock(LOCK_EX) fails with error (not EBUSY, not ENOENT)
    → Log error with errno, ABORT fence activation
    → ROLLBACK the DB transaction
    → Release any already-acquired file locks
    → Return 500, alert operator
    → Fence is NOT active (fail-closed)
  
  Case 3: flock(LOCK_EX) blocks beyond timeout (30 seconds)
    → Log error, ABORT fence activation
    → ROLLBACK, release locks, return 500, alert
    → Rationale: Writer stuck holding LOCK_SH; cannot safely fence.
  
  Case 4: Success → hold LOCK_EX, proceed
```

**Why missing file is safe to skip (addresses reviewer):**

The race the reviewer is concerned about: reservation created, but file not yet created, fence activates, then writer creates file and writes.

This cannot happen because:
1. The writer creates the `.part` file BEFORE acquiring LOCK_SH (file creation is step 0 of Phase-2).
2. Fence activation enumerates reservations from the DB, then tries to lock each file.
3. If the file doesn't exist at enumeration time, either:
   a. The writer hasn't created it yet → writer will create it, then try LOCK_SH → but fence holds L1 and is in the process of invalidating → writer's reservation check (under LOCK_SH) will see ABANDONED (if fence committed) or block (if fence holds LOCK_EX on a different file — no, different file).
   
   Actually, the precise guarantee: Fence activation holds L1 during the entire enumeration + lock acquisition + DB invalidation. A new writer trying to start Phase-2 must first have a reservation (created via Phase-1, which requires L1). If fence holds L1, Phase-1 blocks. Therefore no new writers can start during fence activation.
   
   b. The writer created the file but crashed before acquiring LOCK_SH → file exists but no writer → safe to skip (no active writer to block).

**All-or-nothing clarified:**

"All active writers are blocked" means: all writers that were active at enumeration time AND had created their files. Writers that haven't created files yet cannot exist (see above: Phase-1 requires L1, which fence holds).

**Crash during fence activation:**

The reviewer asked about "partially invalidated" reservations vs atomic transaction.

Clarification: The DB updates (steps 4a, 4b) are in a SINGLE PostgreSQL transaction. If the process crashes:
- Before COMMIT → transaction rolls back → NO reservations invalidated, fence NOT active. Atomic.
- After COMMIT → all reservations invalidated, fence active. Atomic.
- There is NO "partially invalidated" state from the DB perspective.

The "partial" concern was about file locks: if we acquire LOCK_EX on 5 files, then crash before DB COMMIT:
- Kernel releases the flock() locks on process exit.
- DB transaction rolls back (connection closed).
- Result: No fence, no invalidation. Clean.
- Writers that were blocked on LOCK_EX will now acquire it and proceed normally.

The document previously said "may leave reservations partially invalidated" — this was incorrect. The single-transaction guarantee holds. Corrected here.

**Crash behavior:**
- If fence activation crashes while holding LOCK_EX: kernel releases flock on process exit. Reservations may be partially invalidated → operator resolves via runbook.
- If writer crashes while holding LOCK_SH: kernel releases. Fence activation proceeds. Partial chunk may be in file → reservation is ABANDONED → RES-1c reaps → temp cleanup removes .part file.
- If writer crashes between check and write (holding LOCK_SH): impossible — check and write are in the same critical section (no await points that release the lock).

**Lock release ordering:**
- Writer: Always releases LOCK_SH after write (try/finally).
- Fence: Releases LOCK_EX only after DB COMMIT. If COMMIT fails, still releases locks (reservations may be inconsistent → alert).

**Failed writes:** If `write()` syscall fails:
- Writer releases LOCK_SH, throws.
- Reservation remains (not invalidated by this).
- Upload can retry the chunk (Phase2Writer handles).
- Fence activation is unaffected.

**Partial files:** A .part file with partial chunks and ABANDONED reservation is cleaned by:
1. RES-1c expiry worker (reaps reservation after expiry)
2. Stale-temp cleanup (§1.6e, RES-1b) removes the .part file

**Reservation expiry:** Unchanged. Expired reservations are reaped by RES-1c. The fence does not affect expiry.

#### Deterministic Race Test

```typescript
it('fence activation blocks until in-flight chunk completes, then rejects next chunk', async () => {
  // Setup: Create reservation, start writer
  const reservationId = await createTestReservation();
  const writer = new Phase2Writer(reservationId);
  
  // Writer acquires LOCK_SH and pauses AFTER check but BEFORE write
  // (inject a test hook that signals when lock is held)
  const chunkPromise = writer.writeChunkWithPause(
    testChunk,
    { pauseAfterCheck: true }  // Test-only hook
  );
  await writer.waitForLockHeld();  // Deterministic: writer holds LOCK_SH
  
  // Concurrently activate fence (in another "process" — use a separate DB connection + fork)
  const fencePromise = activateFence();
  
  // Fence must block (cannot acquire LOCK_EX while writer holds LOCK_SH)
  // Deterministic: poll /proc/locks with bounded timeout (not fixed sleep)
  await waitForCondition(
    async () => await isFenceBlocked(),
    { timeoutMs: 5000, intervalMs: 50, message: 'Fence did not block on writer lock' }
  );
  
  // Let writer complete the chunk
  writer.resume();
  await chunkPromise;  // Chunk written successfully (fence wasn't effective yet)
  
  // Now fence completes
  await fencePromise;
  expect(await isFenceActive()).toBe(true);
  
  // Next chunk must be rejected
  await expect(writer.writeChunk(testChunk2)).rejects.toThrow('FENCED_WRITE_REJECTED');
  
  // Proof: No chunk was written after the fence-effective point
  const fileSize = await getPartFileSize(reservationId);
  expect(fileSize).toBe(testChunk.length);  // Only first chunk, not second
});
```

**Test determinism:**
- `waitForLockHeld()` uses a promise that resolves when the writer acquires LOCK_SH (instrumented via test hook).
- `isFenceBlocked()` checks `/proc/locks` for a BLOCKED flock request on the .part file.
- `waitForCondition()` polls with 50ms interval, 5s timeout. Fails the test on timeout (does not pass silently).
- No fixed `sleep()` for ordering; only bounded polling for failure detection.
- The test proves: (1) fence waits for in-flight chunk, (2) post-fence chunks are rejected, (3) no bytes written after effective point.

```typescript
async function waitForCondition(
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number; message: string }
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`Timeout: ${opts.message}`);
}
```

## 4. API Contract

### POST /worlds/:id/media

**Request:** `multipart/form-data` with single `file` field.

**Responses:**
- `201`: `{ url: "/media/{filename}", assetId: "{uuid}" }`
- `400`: No file uploaded
- `401`: Not authenticated
- `403`: Not world creator
- `404`: World not found
- `413`: File too large (`FILE_TOO_LARGE`)
- `415`: Invalid file type (magic bytes mismatch)
- `503`: `BACKFILL_IN_PROGRESS` or `FENCE_ACTIVE`
- `507`: `QUOTA_EXCEEDED` or `STORAGE_FULL`

### Legacy Path Retirement (addresses review: fallback contradiction)

**Decision:** The old direct-write path is REMOVED, not feature-flagged.

**Rationale:** A `USE_ADR017_UPLOAD` flag that falls back to the unsafe path silently restores every bypass the ADR was written to eliminate (no quota, no registry, no crash safety). A flag that can be flipped to "unsafe mode" is not a safety mechanism.

**Migration:** The old route handler is deleted. All uploads go through the ADR-017 path. There is no grace period because:
1. The old path never created registry rows, so there's nothing to backfill from it.
2. Files uploaded via the old path remain servable via `/media/` (filesystem unchanged).
3. New uploads must meet the new guarantees; no exception.

**If rollback is needed:** Deploy the previous release (git revert), don't add a runtime flag.

## 5. Acceptance Criteria

### Independent (UPLOAD-1 must satisfy alone)
- [ ] S23: Same bytes, different filenames → two rows, never merged
- [ ] Magic bytes validation rejects mismatched content with 415
- [ ] Backfill freeze returns 503 (via L1-serialized check in Phase-1)
- [ ] Fence active returns 503 (via L1-serialized check in Phase-1)
- [ ] All existing quota/reservation error codes preserved (507 QUOTA_EXCEEDED, etc.)
- [ ] 201 returned only after asset is ACTIVE, includes both `url` and `assetId`
- [ ] Staged temp file deleted on reservation failure
- [ ] 11 MB upload → 413 through production path (already tested in QUOTA-1)

### Gated on REF-1 (deferred until REF-1 is implemented)
- [ ] S8: Failed metadata switch → orphan recovery path (needs REF-1's atomic roles update)
- [ ] S24: Failed replacement does not corrupt roles (needs REF-1's reference-aware roles)

UPLOAD-1 implements the upload flow; REF-1 implements the reference validation. The replacement T2 path (which needs both) is deferred until REF-1 passes.

## 6. Out of Scope

- DEL-1 (deletion) — separate slice
- SHARE-1 (shared assets) — separate slice
- REF-1 (reference validation) — parallel slice, but UPLOAD-1's T2 switch will use it when available
- Backfill itself (BF-1) — separate slice

## 7. Dependencies

- MIG-0 ✅ (complete)
- RES-1a ✅ (accepted)
- RES-1b ✅ (implemented, source-review cleared)
- RES-1c ✅ (implementation PASS)
- QUOTA-1 ✅ (code review accepted)
- REF-1 (parallel — UPLOAD-1's replacement T2 will integrate when ready)
