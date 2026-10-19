# ADR-017 DEL-2 Design: World Deletion T1–T5

**Status:** DRAFT rev 2 — self-review fixes (nullable world_id, T3 state check, FK clarifications)
**Date:** 2026-10-19
**Scope:** ADR-017 §4.9 (world deletion), §4.3c (lock positions), §4.3d (lock ownership)

## 1. Objective

Implement draft-only world deletion as a 5-transaction state machine with crash recovery. Published worlds cannot be deleted (409 `WORLD_HAS_PUBLISHED_VERSIONS`).

## 2. Preconditions

- World must be draft-only (no published snapshots)
- Caller must own the world
- Fence and backfill checks (503 if active)

## 3. State Machine

### T1: Preparation (locks → checks → transfers → job row)

**Locks:** L1 → L2(world) → world row `FOR UPDATE`

**Steps:**
1. Acquire L1, check fence/backfill → 503 if active
2. Acquire L2 for this world, lock world row
3. Check for published snapshots → 409 `WORLD_HAS_PUBLISHED_VERSIONS` if any
4. **Shared-asset transfer:** For each asset owned by this world with non-empty `shared_with_worlds`:
   - Transfer ownership to first world in `shared_with_worlds` array
   - Remove that world from the array (it becomes owner, not borrower)
   - Log transfer
5. **Snapshot-protected transfer:** For each asset with rows in `asset_snapshot_references`:
   - Cannot delete (protected) — transfer to "unattributed" state
   - Set `world_id = NULL` (requires migration 024 to make `world_id` nullable;
     currently NOT NULL per MIG-0 — this is a schema change)
   - Keep snapshot refs (they pin the asset by ID)
   - Remove from world's asset list (no longer counted in quota)
6. Create deletion job row in `world_deletion_jobs`:
   ```sql
   INSERT INTO world_deletion_jobs (job_id, world_id, state, created_at)
   VALUES ($1, $2, 't1_complete', now())
   ```
7. COMMIT

### T2: Mark Deletion (reacquire → mark → cleanup)

**Locks:** L1 → L2 → world row → all asset rows (sorted)

**Steps:**
1. Reacquire locks, verify job state = 't1_complete'
2. Mark all remaining owned assets as `pending_deletion`
3. Clean up `referencing_worlds` (remove this world from others' shared arrays)
4. Update job state to 't2_complete'
5. COMMIT

### T3: File Deletion (per-file unlink)

**Locks:** L1 → L2 (no row locks — filesystem operation)

**Steps:**
1. Acquire L1, L2
2. Verify job state = 't2_complete' (abort if not — another worker may be running)
3. For each asset in `pending_deletion` for this world:
   - Enumerate file path, `stat()` to verify existence
   - `unlink()` the file
   - `fsync()` parent directory
   - Log each deletion (for crash recovery)
3. Update job state to 't3_complete'
4. COMMIT

**Crash recovery:** If crash occurs during T3, the recovery worker enumerates files on disk vs. job log to determine which were deleted.

### T4: Row Cleanup (row removal)

**Locks:** L1 → L2 → asset rows (sorted)

**Steps:**
1. Reacquire locks, verify job state = 't3_complete'
2. For each `pending_deletion` asset:
   - `DELETE FROM world_media_assets WHERE asset_id = $1`
   - `DELETE FROM asset_snapshot_references WHERE asset_id = $1` (should be empty — T1 transferred protected ones)
3. Clean up `shared_with_worlds` references in other worlds' assets (array_remove)
4. Update job state to 't4_complete'
5. COMMIT

### T5: World Deletion (final)

**Locks:** L1 → L2 → world row

**Steps:**
1. Reacquire locks, verify job state = 't4_complete'
2. Delete world row: `DELETE FROM worlds WHERE world_id = $1`
   - Cascades to scenes, choices, etc. (via FK `ON DELETE CASCADE`)
   - Does NOT cascade to `world_media_assets` (already cleaned in T4; FK is `ON DELETE RESTRICT` or manual)
   - Does NOT cascade to `world_deletion_jobs` (keep for audit; FK is `ON DELETE SET NULL` or no FK)
   - **Note:** The existing simple-delete handler is replaced. If any FK would block
     the delete (e.g., orphaned asset rows), T5 fails with 500 and the job stays in
     't4_complete' for operator intervention.
3. Update job state to 'complete'
4. COMMIT
5. Return 204

## 4. Crash Recovery Worker

A background worker monitors `world_deletion_jobs` for jobs stuck in non-terminal states:

- **State 't1_complete':** Resume at T2
- **State 't2_complete':** Resume at T3 (enumerate files)
- **State 't3_complete':** Resume at T4
- **State 't4_complete':** Resume at T5

**Locking:** Worker acquires a session-level advisory lock (`pg_advisory_lock`, not xact) on `hashtext('world_deletion_worker')` to ensure single instance.

**Counter rebuild:** If crash occurred during T3 (file deletion), the worker rebuilds the deleted-file list by enumerating `/data/media/` and comparing against the job's asset list.

## 5. Error Codes

| Condition | Code | HTTP |
|-----------|------|------|
| World has published versions | `WORLD_HAS_PUBLISHED_VERSIONS` | 409 |
| World not found | (404) | 404 |
| Fence active | `FENCE_ACTIVE` | 503 |
| Backfill in progress | `BACKFILL_IN_PROGRESS` | 503 |
| Job already in progress | `DELETION_IN_PROGRESS` | 409 |

## 6. Acceptance Criteria

- [ ] S10: Blocked with published versions; resumable for draft-only
- [ ] S16: Concurrent publish vs deletion — one wins (via world row lock)
- [ ] S17: Crash after unlink, before counter update → recovery enumerates
- [ ] S29: Crash around T4 — unattributed references preserved
- [ ] S33: Lock re-acquisition across the multi-transaction pass

## 7. Dependencies

- MIG-0 ✅ (base tables)
- DEL-1 ✅ (asset deletion — T3/T4 reuse the unlink logic)
- SHARE-1 ✅ (shared assets, snapshot refs — T1 implements transfer contracts)

## 8. Out of Scope

- Deleting published worlds (blocked by design)
- DRIFT-1 (orphan reconciliation — separate)
- API-1 (formalizes the endpoint contract)

## 9. Migration

**023_world_deletion_jobs.sql:**
```sql
CREATE TABLE IF NOT EXISTS world_deletion_jobs (
  job_id UUID PRIMARY KEY,
  world_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    't1_complete', 't2_complete', 't3_complete', 't4_complete', 'complete', 'failed'
  )),
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deletion_jobs_state ON world_deletion_jobs(state);
CREATE INDEX IF NOT EXISTS idx_deletion_jobs_world ON world_deletion_jobs(world_id);
```

**024_nullable_asset_world.sql** (REQUIRED for T1 step 5):
```sql
-- Allow assets to exist without an owning world (unattributed/snapshot-protected)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'world_media_assets'
      AND column_name = 'world_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.world_media_assets ALTER COLUMN world_id DROP NOT NULL;
    RAISE NOTICE 'Made world_media_assets.world_id nullable';
  END IF;
END $$;
```

## 10. API Contract

```
DELETE /worlds/:id
```

**Responses:**
- `204` — World deleted successfully
- `404` — World not found
- `409` — `WORLD_HAS_PUBLISHED_VERSIONS` or `DELETION_IN_PROGRESS`
- `503` — `FENCE_ACTIVE` or `BACKFILL_IN_PROGRESS`

**Note:** This replaces the existing `DELETE /worlds/:id` handler (which does a simple delete). The new handler implements the T1-T5 state machine.
