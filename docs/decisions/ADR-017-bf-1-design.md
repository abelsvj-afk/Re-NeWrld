# ADR-017 BF-1 Design: Backfill Runner

**Status:** DRAFT rev 2 — self-review fixes (manifest attribution, quota note)
**Date:** 2026-10-19
**Scope:** ADR-017 §4.7 (backfill), §4.7b (freeze + hash + completion), §4.7c (re-verification)

## 1. Objective

Migrate legacy media files (uploaded before ADR-017, without registry rows) into the `world_media_assets` registry. This is a one-time operation per deployment, run under maintenance fence.

## 2. Problem

Before ADR-017, files were written directly to `/data/media/` without registry tracking. These "unattributed" files:
- Don't count against quota
- Can't be referenced via REF-1 validation
- Aren't protected by DEL-1

The backfill scans the filesystem, classifies each file, and creates registry rows.

## 3. Backfill Job Lifecycle

### 3.1 Run Row

```sql
CREATE TABLE backfill_runs (
  run_id UUID PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'complete', 'failed')),
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  file_count INT DEFAULT 0,
  error TEXT
);
```

Only one `in_progress` run at a time (enforced by unique partial index).

### 3.2 Phases

**Phase 1: Freeze**
1. Activate maintenance fence (FENCE-1)
2. Create `backfill_runs` row with state='in_progress'
3. Record `attribution_input_hash` = SHA-256 of sorted file listing

**Phase 2: Inventory**
1. List all files in `/data/media/` (recursive, excluding `.tmp/`, `.staging/`, `.lock` files)
2. For each file:
   - Compute SHA-256
   - Detect mimetype via magic bytes (reuse UPLOAD-1's `detectMimetypeFromMagic`)
   - Get file size via stat

**Phase 3: Classification**
For each file, determine:
- **Owner world:** Determined via operator-provided manifest
  - The operator provides a JSON manifest mapping filenames to world IDs:
    ```json
    { "abc123.png": "world-uuid-1", "def456.jpg": "world-uuid-2" }
    ```
  - Files not in manifest → `world_id = NULL` (unattributed, servable via X-Unattributed)
  - Manifest is validated before Phase 4 (all world IDs must exist)
- **Role:** `cover` vs `illustration` — determined by which world/scene references the URL
  - Scan `worlds.metadata->>'coverArtUrl'` and `scenes.metadata->>'illustrationUrl'`
  - If URL matches → assign role
  - If no match → role = `unattributed`

**Phase 4: Registry Insert**
For each classified file, in a single L1-held transaction:
**Note:** Backfilled assets count toward world quota via `quota_used_bytes()`
(lifecycle='active'). If a world exceeds quota after backfill, subsequent
uploads will fail with 507 until usage is reduced. This is intentional —
the files already exist on disk.
```sql
INSERT INTO world_media_assets
  (asset_id, world_id, url, filename, mimetype, size_bytes, content_sha256,
   lifecycle, file_confirmed_present, roles)
VALUES (...);
```

**Phase 5: Verification**
1. Re-scan filesystem, recompute `attribution_input_hash`
2. Compare to Phase 1 hash — if different → FAIL (files changed during backfill)
3. Count registry rows vs. file count — must match (or document discrepancies)

**Phase 6: Complete**
1. Update `backfill_runs` to state='complete'
2. Release fence (operator action, not automatic)

## 4. Write Freeze Enforcement

During backfill (`backfill_runs.state = 'in_progress'`):
- UPLOAD-1 rejects with 503 `BACKFILL_IN_PROGRESS`
- REF-1 rejects with 503 `BACKFILL_IN_PROGRESS`
- DEL-1 rejects with 503 `BACKFILL_IN_PROGRESS`
- (Already implemented in those slices)

## 5. Conflict Handling

If a file's metadata changes between inventory and insert (e.g., file replaced):
- Detect via SHA-256 mismatch
- Record in `backfill_conflicts` table
- Do NOT overwrite — operator resolves manually (DRIFT-1)

```sql
CREATE TABLE backfill_conflicts (
  conflict_id UUID PRIMARY KEY,
  run_id UUID REFERENCES backfill_runs(run_id),
  filename TEXT NOT NULL,
  expected_sha256 TEXT,
  actual_sha256 TEXT,
  resolution TEXT, -- 'accept-recomputed' | 'keep-existing' | NULL (unresolved)
  resolved_at TIMESTAMPTZ
);
```

## 6. Rerun Semantics

- If backfill fails, rerun starts fresh (new `run_id`)
- Already-registered files are skipped (matched by SHA-256)
- `backfill_conflicts` from prior runs are preserved

## 7. Acceptance Criteria

- [ ] S12: Legacy files backfilled before enforcement (fence blocks writes until complete)
- [ ] S30: Interrupted backfill cannot enable enforcement (fence stays until state='complete')
- [ ] S31: Rerun with changed metadata → conflict recorded, not overwritten
- [ ] S32: File added during freeze → blocked by fence, caught in verification
- [ ] S50: Snapshot refs populated for backfilled assets (via SHARE-1 logic)

## 8. Dependencies

- MIG-0 ✅, OPS-0 ✅ (volume must exist)
- FENCE-1 (partial) — fence activation
- SHARE-1 ✅ (snapshot ref population logic)

## 9. Out of Scope

- DRIFT-1 (conflict resolution — separate slice)
- Automatic fence release (operator action)
- Real-time file watching (one-time backfill only)

## 10. Migration

**026_backfill_tables.sql:**
```sql
CREATE TABLE IF NOT EXISTS backfill_runs (...);
CREATE TABLE IF NOT EXISTS backfill_conflicts (...);
CREATE UNIQUE INDEX IF NOT EXISTS idx_backfill_single_active
  ON backfill_runs (state) WHERE state = 'in_progress';
```
