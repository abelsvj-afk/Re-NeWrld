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
    CHECK (state IN ('active', 'expiring', 'expired', 'cancelled'))
    DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reservation_id UUID REFERENCES storage_reservations(reservation_id),
  -- State machine (enforced by application transaction logic, not CHECK constraints):
  -- 'active' → 'expiring': cleanup job sets this when expires_at < now()
  -- 'active' → 'cancelled': conversion commits OR user cancels
  -- 'expiring' → 'expired': cleanup deletes file, then updates state
  -- 'expiring' → 'cancelled': conversion wins race (UPDATE ... WHERE state IN ('active','expiring'))
  --
  -- NOTE (rev 10): PostgreSQL CHECK constraints must use immutable expressions.
  -- now() is not immutable, so the expiry invariant cannot be a CHECK constraint.
  -- Instead:
  --   1. Cleanup job only sets 'expiring' where expires_at < now() (in its UPDATE WHERE clause)
  --   2. Conversion accepts 'expiring' regardless of timestamp (writer may be slow)
  --   3. Application code validates state transitions; invalid transitions are bugs, caught by tests.
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
- `active` → counted (normal, file streaming or staged)
- `expiring` → counted (expiry detected, file may still exist)
- `expired`, `cancelled` → not counted (terminal states, file deleted or converted)

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

**Authoritative conversion transaction (rev 8: file lock coordinated):**

**Critical fix (reviewer blocker 1):** Conversion MUST hold the staging file lock during the DB transaction. Otherwise cleanup can delete the file after conversion commits.

```
CONVERSION SEQUENCE:
1. Acquire LOCK_EX (blocking) on /data/media/.staging/{allowance_id}.tmp
   -- If file does not exist → abort, return 500 STAGING_FILE_MISSING
   -- This lock is held for the entire conversion (DB txn + file move)
   -- Cleanup job uses LOCK_EX|LOCK_NB → will fail (EBUSY) → skips

2. BEGIN DB transaction
   -- L1: pg_advisory_xact_lock(hashtext('media_global'))
   -- L2: pg_advisory_xact_lock(hashtext('media_quota:' || world_id))
   -- World row: SELECT ... FOR UPDATE
   
3. Claim the allowance:
   UPDATE staging_allowances 
   SET state = 'cancelled',
       reservation_id = $reservation_id_placeholder
   WHERE allowance_id = $1 
     AND state IN ('active', 'expiring');
   -- If 0 rows → ROLLBACK, release file lock, delete staged file, 500 STAGING_EXPIRED
   -- Note: Direct to 'cancelled', no 'converting' intermediate.
   -- The row lock (from UPDATE) serializes vs cleanup job's UPDATE.

4. Re-check fence and backfill:
   SELECT active FROM system_maintenance WHERE id = 1;
   -- If active → ROLLBACK (allowance reverts to 'active'/'expiring'), release file lock, 503
   
5. Create reservation via reserveStorage(actual_bytes):
   -- quota_used_bytes() does NOT count 'cancelled' allowances
   -- The allowance was just marked 'cancelled', so no double-count
   -- INSERT into storage_reservations (counted)
   -- If quota exceeded → ROLLBACK (allowance reverts), release lock, 507

6. UPDATE staging_allowances SET reservation_id = $actual_reservation_id
   WHERE allowance_id = $1;
   -- Link for audit trail

7. COMMIT
   -- L1, L2 released
   -- Allowance is 'cancelled' (not counted), reservation is counted
   -- Atomic: no point where both or neither are counted

8. Transfer bytes into the pre-created .part file (rev 12: preserves inode):
   -- The .part file was created empty at reservation time (rev 11).
   -- DO NOT rename over it (that would replace the inode).
   -- Instead:
   a. Acquire LOCK_EX on /data/media/.tmp/{reservation_id}.part
      using BOUNDED RETRY (rev 13: fixes deadlock with fence):
      -- We already hold LOCK_EX on the staging file (step 1).
      -- Fence may hold LOCK_EX on .part while waiting for staging file.
      -- Use LOCK_EX|LOCK_NB with 50ms sleep, 30s deadline (same as fence).
      -- On timeout (rev 14: fail-closed without L1):
      --   1. Mark reservation ABANDONED (single UPDATE, no L1):
      --      UPDATE storage_reservations SET state = 'ABANDONED'
      --      WHERE reservation_id = $1 AND state = 'RESERVED';
      --      -- No L1 needed: single-row state change, row lock suffices.
      --      -- If fence already marked it ABANDONED → 0 rows, harmless.
      --   2. DO NOT delete the staging file yet.
      --      -- The staging file is the ONLY complete copy of the bytes.
      --      -- Deleting it before the reservation is safely terminal risks data loss
      --      -- if the ABANDONED update fails or the process crashes.
      --   3. Release staging file LOCK_EX.
      --   4. Return 500.
      --   
      --   Recovery:
      --   - Reservation is ABANDONED (or will be, if step 1 raced fence).
      --   - Staging file remains → orphan sweep finds 'cancelled' allowance
      --     with ABANDONED reservation → deletes staging file after
      --     verifying no .part transfer is in progress (via .part lock check).
      --   - Empty .part file → stale-temp cleanup deletes.
      --   
      --   Why no L1: The abandonment is a terminal state change on a single row.
      --   It doesn't affect quota calculations (ABANDONED reservations are not
      --   counted). The row-level lock from UPDATE provides atomicity.
      --   Acquiring L1 here could deadlock with fence holding L1 while waiting
      --   for the staging lock we hold. (Rev 14 fixes rev 13 blocker 2.)
   b. Copy bytes: staging file → .part file
      -- Use copy_file_range() or read/write loop (not rename)
      -- The .part file grows from 0 bytes to actual_bytes
      -- Inode is preserved; fence's LOCK_EX (if held) blocks us here
   c. fsync() the .part file descriptor
      -- Ensures bytes are durable before we release locks
   d. fsync() the parent directory (/data/media/.tmp/)
      -- Ensures the file size update is durable
   e. Delete the staging file: unlink(/data/media/.staging/{allowance_id}.tmp)
   
   f. Mark transfer complete (rev 14: no L1 — single-row update):
      ```sql
      -- Single statement, autocommit. No L1 needed.
      -- This is a single-row flag flip, not a quota-affecting operation.
      -- The row lock from UPDATE is sufficient for atomicity.
      UPDATE storage_reservations 
      SET bytes_ready = true 
      WHERE reservation_id = $1 AND state = 'RESERVED';
      -- If 0 rows → reservation was ABANDONED (fence) or reaped → abort transfer
      ```
      -- Still holding LOCK_EX on .part file during this UPDATE.
      -- The flag is set AFTER fsync, so bytes are durable.
      -- No L1 → no deadlock with fence holding L1 (rev 14 fixes rev 13 blocker 1).
   
   g. Release LOCK_EX on .part file
   h. Release LOCK_EX on staging file (already unlinked, just close fd)

   -- If copy fails partway → .part file has partial bytes, bytes_ready=false
   -- → Return 500; reservation remains with bytes_ready=false
   -- → Phase-2 writer will refuse (checks flag)
   -- → RES-1c reaps reservation after expiry; stale-temp cleanup deletes .part
   -- → Staging file remains (orphan sweep cleans it)

9. Done. Locks released. Reservation has bytes_ready=true, .part file complete.
```

**Why this closes the race (reviewer blocker 1):**

| Interleaving | Outcome |
|--------------|---------|
| Conversion acquires file lock, then cleanup tries | Cleanup's `LOCK_EX|LOCK_NB` fails (EBUSY) → cleanup skips entirely (no DB update, no delete) |
| Cleanup acquires file lock, then conversion tries | Conversion blocks on `LOCK_EX` (step 1) → cleanup deletes file, marks 'expired', releases → conversion acquires lock, but file is gone → step 1 detects missing file → aborts |
| Both try DB UPDATE simultaneously | PostgreSQL row lock serializes. Winner's `WHERE state IN ('active','expiring')` matches; loser's doesn't (state already changed). |

**The key:** Conversion holds the FILE lock for the entire operation (DB txn + rename). Cleanup cannot delete the file while conversion holds the lock. The DB UPDATE is the mutual exclusion point for state, and the file lock is the mutual exclusion point for the filesystem.

**Rollback semantics (reviewer blocker 2 - corrected):**

If the transaction ROLLBACKs (fence active, backfill, quota exceeded):
- The `UPDATE staging_allowances SET state='cancelled'` is undone.
- Allowance returns to `'active'` or `'expiring'` (whatever it was before).
- It is COUNTED again in quota (correct: the file still exists).
- File lock is released.
- Staged file remains (will be cleaned by expiry or retry).
- Return the appropriate error (503/507).

The document previously said the allowance "remains converting" — this was WRONG. ROLLBACK reverts the state. Corrected here.

**Crash recovery (reviewer blocker 2):**

| Crash point | DB state | File state | Recovery |
|-------------|----------|------------|----------|
| Before BEGIN | Allowance 'active'/'expiring' | Staged file exists, no lock held | Cleanup job: marks 'expiring'→'expired', deletes file |
| During DB txn (before COMMIT) | Transaction rolls back on connection close | File locked? No (lock released on process exit) | Allowance reverts to pre-txn state. Cleanup handles. |
| After COMMIT, before byte transfer | Allowance 'cancelled', reservation exists | Staged file exists, .part is empty (0 bytes), locks released (process died) | Orphan sweep: finds 'cancelled' allowance → checks reservation → .part exists but empty → delete staged file, log. Reservation reaped by RES-1c (no Phase-2 writer will pick up empty file). |
| During byte transfer (copy) | Allowance 'cancelled', reservation exists | Staged file exists, .part has partial bytes, locks released on crash | .part has partial data. Orphan sweep: sees 'cancelled' + reservation → leaves .part (not empty, not complete). RES-1c reaps reservation after expiry. Stale-temp cleanup deletes .part. Staged file deleted by orphan sweep. |
| After transfer, before staging delete | Allowance 'cancelled', reservation exists | Staged file exists, .part has full bytes | Orphan sweep: deletes leftover staged file. .part is complete; Phase-2 can proceed (or RES-1c reaps if no writer). |
| After staging delete | Allowance 'cancelled', reservation exists | .part has full bytes, no staging file | Normal: Phase-2 writer picks it up. |

**No stranded 'converting':** The state doesn't exist anymore. The only non-terminal states are 'active' and 'expiring', both handled by cleanup.

**Transaction boundaries (rev 8):**
- Allowance creation: Single transaction. Locks: L1 → L2 → world row FOR UPDATE.
- Streaming: NO DB transaction. Holds: LOCK_EX on staging file.
- Conversion: Single transaction. Holds: LOCK_EX on staging file (acquired before BEGIN).
  Locks (in order): L1 → L2 → world row FOR UPDATE → allowance row (via UPDATE).
- File move: After COMMIT, still holding file LOCK_EX. Then release.

**Complete lock order (rev 12):**

The conversion acquires locks in strict order:
1. **Filesystem:** `LOCK_EX` on `/data/media/.staging/{allowance_id}.tmp` (before BEGIN)
2. **L1:** `pg_advisory_xact_lock(hashtext('media_global'))`
3. **L2:** `pg_advisory_xact_lock(hashtext('media_quota:' || world_id))`
4. **World row:** `SELECT ... FROM worlds WHERE world_id=$1 FOR UPDATE`
5. **Allowance row:** `UPDATE staging_allowances ... WHERE allowance_id=$1` (row lock via UPDATE)
6. **(Inside reserveStorage):** Reservation row INSERT + `.part` file creation (empty)
7. **COMMIT** (releases L1, L2, row locks; file locks held)
8. **Filesystem:** `LOCK_EX` on `/data/media/.tmp/{reservation_id}.part` (after COMMIT, before transfer)
9. Byte transfer: staging → .part (holding both file locks)
10. Release .part lock, release staging lock (after unlink)

**Lock ordering rationale:**
- Staging file lock before L1: prevents cleanup from deleting staging file during conversion.
- .part file lock after COMMIT: the .part file didn't exist before the transaction (created in step 6). We acquire its lock after COMMIT to avoid holding it during the DB txn unnecessarily.
- Fence activation order: L1 → .part LOCK_EX → staging LOCK_EX (for in-flight conversions).
  
  Potential cycle: Conversion holds staging lock, wants .part lock. Fence holds .part lock, wants staging lock.
  Resolution: Both use bounded retry (LOCK_NB + 50ms sleep, 30s deadline). No indefinite blocking. Timeout → abort fail-closed.

**Inode preservation proof:**
- Step 6 creates `.part` with inode I.
- Step 8 acquires LOCK_EX on inode I (via path, bounded retry).
- Step 9 writes bytes into inode I (no rename, no replacement).
- Fence acquiring LOCK_EX on the `.part` path always gets inode I.
- Writer acquiring LOCK_SH on the `.part` path always gets inode I.
- No inode replacement → no lock splitting.

**Interleaving: bytes_ready update vs fence (rev 14 explicit):**

Scenario: Conversion holds `.part` LOCK_EX, does the `bytes_ready` UPDATE (no L1).
Fence holds L1, is in bounded retry for `.part` LOCK_EX.

- Fence's retry loop runs for up to 30s, then times out.
- Fence releases L1, ROLLBACKs, aborts (fail-closed).
- Conversion's UPDATE proceeds (no L1 contention — it doesn't need L1).
- If fence invalidated the reservation BEFORE conversion's UPDATE:
  → UPDATE affects 0 rows (state is ABANDONED, not RESERVED)
  → Conversion detects this, aborts transfer cleanup.
  → Partial .part file remains; RES-1c reaps; stale-temp cleanup deletes.
- If conversion's UPDATE commits BEFORE fence's invalidation:
  → bytes_ready=true, then fence marks ABANDONED.
  → Phase-2 writer sees ABANDONED → refuses. Safe.
  → .part file has complete bytes but reservation is dead → cleanup deletes.

No deadlock: conversion never waits for L1 while holding .part lock.
Fence's bounded retry guarantees it releases L1 within 30s.

**Coherent bounded protocol (rev 13: no indefinite waits):**

| Participant | Locks held | Waits for | Bounded? |
|-------------|------------|-----------|----------|
| Conversion | Staging LOCK_EX | .part LOCK_EX | Yes: LOCK_NB + 50ms × 30s |
| Conversion | (none after COMMIT) | L1 (in txn) | Yes: PG lock queue (fair) |
| Conversion | .part LOCK_EX | (bytes_ready UPDATE, no lock wait) | Yes: no lock needed |
| Conversion | Staging LOCK_EX | (abandon UPDATE, no lock wait) | Yes: no lock needed |
| Fence | L1 | .part LOCK_EX | Yes: LOCK_NB + 50ms × 30s |
| Fence | L1 + .part LOCK_EX | Staging LOCK_EX | Yes: LOCK_NB + 50ms × 30s |
| Cleanup | (none) | Staging LOCK_EX | Yes: single LOCK_NB attempt |
| Phase-2 writer | (none) | .part LOCK_SH | Yes: blocks briefly (chunk is fast) |

**Deadlock freedom:** Every blocking wait is either:
- A PostgreSQL advisory lock (fair queue, no cycle: L1 → L2 → row), OR
- A bounded file-lock retry (30s max, then abort fail-closed).

The conversion↔fence cycle is broken because BOTH sides use bounded retry for the second lock. If they contend:
- One wins within 30s (the other’s txn/lock is brief), OR
- Both timeout → both abort → operator retries. No deadlock, just a failed operation.

**Phase-2 writer blocking:** Writers use blocking `LOCK_SH` (not bounded). This is safe because:
- Chunk writes are fast (<100ms).
- Fence holds `LOCK_EX` briefly (just for DB invalidation).
- Conversion holds `.part` `LOCK_EX` during transfer (bounded by file size / 10 MB max).
- No writer holds `LOCK_SH` while waiting for another lock (check-then-write is atomic under the lock).

**Deadlock prevention (rev 9: provably bounded):**

The cycle: Conversion holds staging file LOCK_EX, wants L1. Fence holds L1, wants staging file LOCK_EX.

**Solution:** Fence activation uses non-blocking lock acquisition with bounded retry. No indefinite blocking syscalls.

Fence acquires each file lock via:
1. Open the file
2. Try `flock(LOCK_EX | LOCK_NB)` — returns immediately, never blocks
3. If success → hold the lock, proceed to next file
4. If EWOULDBLOCK (contention) → sleep 50ms (interruptible), retry
5. Repeat until 30 second deadline
6. On deadline → release all held locks, ROLLBACK DB, abort fence (fail-closed)

**Why bounded:** Each flock syscall returns immediately. The sleep is interruptible. Total time is capped at 30s. On timeout, all state is rolled back. No single operation blocks forever.

**Conversion** acquires the staging file lock with blocking `flock(LOCK_EX)` before BEGIN. This is safe because:
- Cleanup job (the only other contender for staging files) uses `LOCK_NB` and never holds the lock while waiting for DB locks.
- No deadlock: conversion waits for file lock (brief, cleanup holds <100ms), then acquires L1. Cleanup never waits for L1 while holding a file lock.

**Fence timeout behavior:**
1. Release all acquired file locks
2. ROLLBACK (no reservations invalidated, fence flag not set)  
3. Log error, alert operator, return 500
4. Operator retries. A writer stuck >30s is likely dead; RES-1c reaps it.

**Quota race:** Two conversions for the same world:
- Both acquire L1 (serializes).
- First commits: allowance→'cancelled', reservation created.
- Second: sees updated quota (first's reservation counted, first's allowance not counted).
- No over-commit.

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
     a. Check `reservation_id` column (set during conversion).
     b. If reservation_id IS NOT NULL:
        - Check if .part file exists at /data/media/.tmp/{reservation_id}.part
        - If .part exists → conversion succeeded, staged file is leftover → delete staged file
        - If .part missing → crash between COMMIT and rename → delete staged file, reservation will be reaped by RES-1c
     c. If reservation_id IS NULL → crash before reservation created (should not happen: single transaction)
        → Log critical, delete staged file, alert operator
     d. In all cases: Try LOCK_EX|LOCK_NB first. If locked → skip (active writer).
  5. If state = 'expired':
     a. File should already be deleted.
     b. If file exists → previous cleanup crashed → retry with LOCK_EX|LOCK_NB.
  6. If state IN ('active', 'expiring'):
     a. Do NOT delete here (handled by main cleanup algorithm).
     b. The main algorithm handles expiry → 'expiring' → delete → 'expired'.
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

2. Enumerate ALL potentially-active writers (rev 10: no expiry filter):
   ```sql
   SELECT reservation_id, expires_at FROM storage_reservations 
   WHERE state IN ('RESERVED', 'WRITING');
   -- NOTE: No expires_at filter. An expired reservation may still have
   -- a writer holding LOCK_SH (e.g., slow network, long chunk).
   -- The fence must wait for it, not skip it.
   ```
   
3. For EACH active reservation:
   a. PartPath = /data/media/.tmp/{reservation_id}.part
   b. Acquire LOCK_EX on PartPath via bounded retry (see below).
      -- The file ALWAYS exists (created at reservation time, rev 11).
      -- No missing-file case for RESERVED/WRITING reservations.
   c. Hold all acquired LOCK_EX locks (do not release yet)
   
   d. Handle in-flight conversions (reservation committed, rename not yet done):
      Query for cancelled staging allowances pointing to enumerated reservations:
      ```sql
      SELECT allowance_id FROM staging_allowances
      WHERE reservation_id = ANY($1) AND state = 'cancelled';
      ```
      For each: StagingPath = /data/media/.staging/{allowance_id}.tmp
      → Acquire LOCK_EX on StagingPath (bounded retry)
      → This blocks the conversion's rename until fence commits.

4. With all writer locks held (LOCK_EX):
   a. UPDATE storage_reservations SET state = 'ABANDONED' 
      WHERE state IN ('RESERVED', 'WRITING');
      -- Same set as enumeration (no expiry filter).
      -- Expired reservations with active writers are invalidated.
      -- Truly stale reservations (expired, no file, no writer) are also
      -- marked ABANDONED — harmless, as RES-1c would reap them anyway.
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

**Stable lock file invariant (rev 11: closes missing-file race):**

**Requirement:** Every `storage_reservations` row in state `RESERVED` or `WRITING` MUST have a corresponding `.part` file on disk from the moment the reservation is created.

**Implementation:**
1. `reserveStorage()` (Phase-1), after INSERTing the reservation row but BEFORE COMMIT:
   - Create empty file at `/data/media/.tmp/{reservation_id}.part`
   - `fsync()` the parent directory (ensures file creation is durable)
2. If file creation fails → ROLLBACK the reservation INSERT → return 500
3. The file exists before any writer can acquire LOCK_SH on it.

**Why this closes the race (reviewer blocker):**
- Before rev 11: Fence could enumerate a reservation with no `.part` file (Phase-2 not started). Writer could then create the file and start writing while fence holds L1 but hasn't locked the file.
- After rev 11: The `.part` file exists from reservation creation. Fence always finds it. Writer and fence always lock the same inode. No missing-file interleaving.

**Writer protocol (rev 13: bytes_ready gate):**
- Writer acquires `LOCK_SH` on the `.part` file for each chunk.
- Under the lock, check BOTH:
  ```sql
  SELECT state, bytes_ready FROM storage_reservations WHERE reservation_id = $1;
  ```
- If `bytes_ready = false` → release lock, throw `TRANSFER_INCOMPLETE`
  -- The initial byte transfer hasn't finished. Do not write chunks.
  -- This prevents Phase-2 from racing conversion.
- If `state NOT IN ('RESERVED', 'WRITING')` → release lock, throw (fence/expiry)
- Otherwise → write chunk, release lock.

**Schema: `bytes_ready` column (rev 13):**
```sql
-- Added to storage_reservations (migration 020, or amended into 014):
ALTER TABLE storage_reservations 
  ADD COLUMN bytes_ready BOOLEAN NOT NULL DEFAULT false;
-- For UPLOAD-1 conversions: set to true after initial transfer.
-- For RES-1a direct reservations (non-upload paths): set to true at creation
--   (they don't have a separate transfer step).
```

**Crash recovery for `bytes_ready=false`:**
| Scenario | Recovery |
|----------|----------|
| Crash during transfer, `bytes_ready=false` | Reservation visible but unusable. Phase-2 refuses. RES-1c reaps after expiry. Stale-temp cleanup deletes partial `.part`. |
| Crash after transfer, before `bytes_ready=true` | Same as above. The bytes are on disk but flag not set. Safe: treated as incomplete. |
| Crash after `bytes_ready=true` | Normal. Phase-2 proceeds. |
| Fence activates during transfer | Fence marks ABANDONED. The `bytes_ready` UPDATE affects 0 rows (state changed). Transfer aborts. Partial file cleaned. |

**Cleanup on reservation end:**
| Reservation end state | .part file handling |
|---------------------|---------------------|
| COMMITTED (Phase-A success) | File renamed to final location by publication. No orphan. |
| ABANDONED (fence) | Stale-temp cleanup (§1.6e) deletes after reservation expiry. |
| EXPIRED (RES-1c reaps) | RES-1c unlinks `.part` after marking ABANDONED. |
| Crash after reservation INSERT, before file creation | Transaction ROLLBACKs (file creation is before COMMIT). No orphan reservation. No orphan file (creation failed). |
| Crash after file creation, before COMMIT | Transaction ROLLBACKs. File exists but no reservation row. Stale-temp cleanup: finds `.part` with no reservation → deletes. |

**Empty .part files:** A newly created reservation has a 0-byte `.part` file. This is normal. Stale-temp cleanup must NOT delete 0-byte `.part` files with live reservations (check DB first).

**Fence activation failure handling (rev 7: consistent contract):**

```
For EACH active reservation:
  Path = /data/media/.tmp/{reservation_id}.part
  
  Case 1: File does not exist at .part path
    → DO NOT SKIP. Check for in-flight conversion:
    
    ```sql
    SELECT allowance_id, state FROM staging_allowances
    WHERE reservation_id = $1 AND state = 'cancelled';
    ```
    
    If a 'cancelled' allowance exists with this reservation_id:
      → Conversion committed the DB but hasn't finished the rename yet.
      → The staging file is at /data/media/.staging/{allowance_id}.tmp
      → Acquire LOCK_EX on the STAGING file (not the .part path)
      → Hold it through DB invalidation
      → After fence commits, the conversion's rename will proceed,
         but the reservation is already ABANDONED → Phase-2 writer
         will see ABANDONED on next chunk → aborts
      → The renamed .part file will be cleaned by RES-1c (reservation expired)
         and stale-temp cleanup.
    
    If NO 'cancelled' allowance exists AND no .part file exists:
      → This should not happen (rev 11 invariant: file created at reservation time).
      → Log WARNING with reservation_id.
      → Treat as stale: skip file lock, DB invalidation suffices.
      → File-creation failure would have rolled back the reservation;
         so a missing file means the reservation row is orphaned or cleanup is in progress.
    
    **Why this works:** The `reservation_id` column in `staging_allowances`
    (added in rev 6) provides the link. Fence activation can discover
    in-flight conversions by querying for cancelled allowances pointing
    to reservations without .part files.
  
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
