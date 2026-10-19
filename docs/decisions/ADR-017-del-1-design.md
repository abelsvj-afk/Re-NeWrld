# ADR-017 DEL-1 Design: Asset Deletion State Machine T1/T2

**Status:** DRAFT rev 1 — initial design for review
**Date:** 2026-10-19
**Scope:** `DELETE /worlds/:id/media/:assetId` implementing ADR-017 §4.3b

## 1. Objective

Implement the two-transaction asset deletion state machine that ensures an asset is only deleted when no active references exist, with crash recovery and idempotent retry.

## 2. State Machine

### T1: Decision Transaction (locks → scan → mark)

**Lock sequence (per §4.3c file-mutating class):**
1. **L1:** `pg_advisory_xact_lock(hashtext('media_global'))`
2. **L2:** `pg_advisory_xact_lock(hashtext('media_quota:' || world_id))`
3. **Asset row:** `SELECT ... FOR UPDATE` on `world_media_assets`

**Steps:**
1. Acquire L1, L2, asset row lock (in order)
2. Verify asset exists and belongs to world → 404 if not
3. Check `lifecycle`: if already `pending_deletion` → idempotent retry (proceed to T2 logic)
4. **Authoritative reference scan:** Query all registered reference paths for this asset's URL
   ```sql
   SELECT 'cover' AS role, world_id FROM worlds
   WHERE metadata->>'coverArtUrl' = $1
   UNION
   SELECT 'illustration' AS role, world_id FROM scenes
   WHERE metadata->>'illustrationUrl' = $1;
   ```
5. If any references found → 409 `ASSET_REFERENCED` with reference list
6. If no references → `UPDATE world_media_assets SET lifecycle = 'pending_deletion' WHERE asset_id = $1`
7. COMMIT (releases locks)

**Error codes:**
| Condition | Code | HTTP |
|-----------|------|------|
| Asset not found | (404) | 404 |
| Active references exist | `ASSET_REFERENCED` | 409 |
| Backfill in progress | `BACKFILL_IN_PROGRESS` | 503 |
| Fence active | `FENCE_ACTIVE` | 503 |

### T2: Execution Transaction (reacquire → verify → delete)

**Lock sequence:** Same as T1 (L1 → L2 → asset row)

**Steps:**
1. Acquire L1, L2, asset row lock
2. Re-verify `lifecycle = 'pending_deletion'` (if not, abort — another transaction changed it)
3. Re-run reference scan (defense in depth — references could have been added between T1 and T2)
4. If references found → 409 `ASSET_REFERENCED` (rollback lifecycle change)
5. **Filesystem:** `stat()` the file path
   - If exists → `unlink()` the file
   - If not exists → log warning (crash recovery case: file already gone)
6. `UPDATE world_media_assets SET file_confirmed_present = false WHERE asset_id = $1`
7. `DELETE FROM world_media_assets WHERE asset_id = $1`
8. COMMIT
9. Return 204

**Idempotency:** If T1 marked `pending_deletion` but T2 crashed before completion, retrying DELETE will:
- Find `lifecycle = 'pending_deletion'` in T1 → skip to T2 logic
- T2 will complete the deletion

**Crash recovery:**
- **File without row:** Orphaned file in `/data/media/`. Detected by DRIFT-1 reconciliation (not DEL-1 scope).
- **Row without file:** T2's `stat()` finds no file → logs warning, proceeds with row deletion. The asset is gone; the row cleanup completes.

## 3. Reference Scan Contract

The scan MUST check all registered reference paths (per REF-1 §3.4a):
- `worlds.metadata->>'coverArtUrl'`
- `scenes.metadata->>'illustrationUrl'`

**Cross-world:** Before SHARE-1, only the owning world's references are checked (same-world invariant). After SHARE-1, the scan expands to include `shared_with_worlds`.

## 4. Interaction with REF-1

REF-1's validator prevents NEW references to `pending_deletion` assets:
- `validateAssetUrl` checks `lifecycle = 'active'` → `pending_deletion` fails with 422 `ASSET_DELETED`
- This ensures no new references are created between T1 and T2

## 5. Quota Impact

When T2 completes (row deleted):
- `quota_used_bytes()` no longer counts the asset (it was counted via `lifecycle IN ('active', 'pending_deletion')`)
- Quota is reclaimed immediately upon COMMIT

## 6. Acceptance Criteria

- [ ] S3: Deletion blocked with reference list (409 `ASSET_REFERENCED`)
- [ ] S4: Unreferenced asset deleted synchronously, quota reclaimed
- [ ] S7: Attach of `pending_deletion` URL → 422 `ASSET_DELETED` (via REF-1)
- [ ] S9: Crash recovery — file-without-row and row-without-file handled
- [ ] S11: Failed scan → 503, changes nothing
- [ ] Idempotent retry on `pending_deletion` completes deletion
- [ ] 404 on already-deleted (success-equivalent, not error)

## 7. Dependencies

- MIG-0 ✅ (`world_media_assets` table)
- REF-1 ✅ (reference validation prevents new refs to deleting assets)
- QUOTA-1 ✅ (quota reclamation via `quota_used_bytes`)

## 8. Out of Scope

- DEL-2 (world deletion, T1-T5)
- SHARE-1 (shared asset deletion semantics)
- DRIFT-1 (orphan file reconciliation)
- Snapshot protection (deferred to SHARE-1)

## 9. API Contract

```
DELETE /worlds/:id/media/:assetId
```

**Responses:**
- `204` — Deleted successfully (or already deleted — idempotent)
- `404` — Asset not found (or not in this world)
- `409` — `ASSET_REFERENCED` with `{ references: [{role, worldId, ...}] }`
- `503` — `BACKFILL_IN_PROGRESS` or `FENCE_ACTIVE`

**Note:** API-1 will formalize the full DELETE endpoint contract. DEL-1 implements the state machine; API-1 adds the HTTP surface refinements.
