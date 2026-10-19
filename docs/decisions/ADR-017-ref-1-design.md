# ADR-017 REF-1 Design: Reference Validation Contract

**Status:** DRAFT rev 2 — addresses ChatGPT review blockers
**Date:** 2026-10-18
**Scope:** §4.2b transaction contract on every reference-setting path

## 1. Objective

Implement the authoritative reference validation contract that ensures every URL stored in scene/world metadata resolves to a valid, active, present registry row before the reference is committed.

## 2. Reference-Setting Paths (§4.2 Canonical Paths Table)

| Path | Operation | Validation Point |
|------|-----------|------------------|
| Scene metadata update | `scene.metadata.illustrationUrl` set | Before metadata commit |
| World metadata update | `world.metadata.coverArtUrl` set | Before metadata commit |
| Publish (validation only) | Validate URLs before snapshot creation | During publish transaction |
| Replacement T2 | Metadata switch to new URL | During T2 transaction |

## 3. Validation Contract (§4.2b)

### 3.1 Transaction Requirements (addresses review: lock contract)

**Exact lock sequence per ADR-017 §4.3c:**

For reference-setting on world W (scene S in world W):

1. **L1:** `pg_advisory_xact_lock(hashtext('media_global'))` — serializes against fence, backfill, other global operations
2. **L2:** `pg_advisory_xact_lock(hashtext('media_quota:' || W))` — serializes against quota operations on W
3. **Row lock:** `SELECT ... FOR UPDATE` on the `worlds` row for W
4. **Asset row lock:** `SELECT ... FOR UPDATE` on the `world_media_assets` row being referenced (if updating roles)

**Deletion vs reference-setting serialization:**

Per §4.3b, deletion T1 acquires:
1. L1 (global)
2. L2 (world)
3. Asset row `FOR UPDATE`

Reference-setting acquires the SAME locks in the SAME order (1→2→3). This guarantees:
- If deletion T1 holds the locks, reference-setting blocks until T1 commits or rolls back.
- If reference-setting holds the locks, deletion T1 blocks.
- No deadlock (consistent global ordering).
- A reference cannot "slip through" — the validator sees the deletion's committed state or blocks until it's resolved.

**Isolation:** `READ COMMITTED` (per §4.2b).
**Atomicity:** URL resolution + validation + metadata write + roles update in single transaction.

### 3.2 Resolution Steps

```
1. Resolve URL → registry row via world_media_assets.url
2. Verify lifecycle = 'active'
3. Verify file_confirmed_present = true
4. Verify no active deletion job for this asset
5. If cross-world URL: verify shared_with_worlds contains requesting world
```

### 3.3 Error Codes

| Condition | Code | HTTP |
|-----------|------|------|
| URL not in registry | `ASSET_UNKNOWN` | 422 |
| lifecycle != 'active' | `ASSET_DELETED` | 422 |
| file_confirmed_present = false | `ASSET_FILE_MISSING` | 422 |
| Active deletion job exists | `ASSET_DELETED` | 422 |
| World deletion in progress | `WORLD_DELETION_IN_PROGRESS` | 409 |
| Backfill freeze active | `BACKFILL_IN_PROGRESS` | 503 |

### 3.4 Roles Atomicity (addresses review: reference-aware semantics)

**Problem:** If two metadata fields point to the same asset (e.g., `coverArtUrl` and a scene's `illustrationUrl` both use `/media/abc.png`), removing one URL must NOT remove the role if the other reference still needs it.

**Solution:** `roles` represents the UNION of all active references to the asset.

Algorithm (inside the validation transaction):
1. Before the metadata update, scan ALL reference-holding fields that point to this asset URL:
   - `worlds.metadata->>'coverArtUrl'`
   - `scenes.metadata->>'illustrationUrl'` for all scenes in the world
   - Any other registered reference paths
2. Compute the set of roles still needed AFTER the proposed change.
3. Update `world_media_assets.roles` to exactly that set.

**Example:**
- Asset A has `roles = ['cover', 'illustration']` (referenced by world cover + scene 5)
- User removes world cover → new roles = `['illustration']` (scene 5 still needs it)
- User removes scene 5 illustration → new roles = `[]`

This is computed from the actual reference graph, not by blindly adding/removing. The S24 failure mode (roles corrupted) is prevented because the roles always reflect reality.

## 4. Cross-World References (S18)

Per §4.7c: a world may reference an asset owned by another world if:
1. The asset's `shared_with_worlds` array contains the referencing world's ID, OR
2. The asset is being shared via the SHARE-1 flow

Validation must NOT return 422 `ASSET_WRONG_WORLD` for valid shared references. The check is:
```sql
WHERE (world_id = $requesting_world_id 
   OR $requesting_world_id = ANY(shared_with_worlds))
```

## 5. Backfill Freeze (addresses review: atomicity contract)

**Problem:** Querying for `in_progress` backfill, then proceeding, allows a backfill to start between check and commit.

**Solution:** The freeze check is performed INSIDE the reference-setting transaction, AFTER acquiring L1.

Per §4.7, backfill start acquires L1 (`pg_advisory_xact_lock(hashtext('media_global'))`). The sequence:

1. Reference-setting transaction acquires L1
2. Checks `backfill_runs` for `in_progress` (sees committed state under L1)
3. If in_progress → ROLLBACK with 503 `BACKFILL_IN_PROGRESS`
4. If not → proceeds; backfill start will block on L1 until this transaction commits

This is the same pattern as UPLOAD-1's Phase-1 (see UPLOAD-1 design §3.3). The L1 lock makes the check atomic with the operation.

## 6. Acceptance Criteria

- [ ] S13: Invalid URLs rejected atomically (no partial metadata write)
- [ ] S18: Cross-world URL → shared reference succeeds (no 422 `ASSET_WRONG_WORLD`)
- [ ] S28: Metadata commit during deletion lock-wait seen by scan (lock ordering)
- [ ] S40: Metadata change during backfill freeze → 503
- [ ] Roles array updated atomically with URL write
- [ ] All four canonical paths enforce the contract

## 7. Dependencies

- MIG-0 ✅ (complete — `world_media_assets` table exists)
- QUOTA-1 ✅ (registry rows created via `commitReservationToRegistry`)

## 8. Blocks

- SHARE-1 (needs reference validation for shared assets)
- UPLOAD-1 T2 switch (replacement flow needs validation)
- DEL-1 (deletion needs to check references before allowing delete)

## 9. Scope Clarification (addresses review: snapshot contradiction)

**REF-1 implements NOW:**
- Validation of URLs at publish time (are they valid, active, present?)
- The validation runs inside the publish transaction
- If validation fails → publish is rejected with 422/503

**Deferred to SHARE-1:**
- Populating `asset_snapshot_references` (the actual snapshot pinning)
- Snapshot lifecycle management
- G1/G2/G3 snapshot guarantees

**Rationale:** REF-1 is the "can this URL be referenced?" gate. SHARE-1 is the "how do we pin it for snapshots?" mechanism. The gate must exist before the pinning, but they're separate concerns.

## 10. Out of Scope

- SHARE-1 implementation (shared asset lifecycle, snapshot pinning)
- DEL-1 implementation (deletion state machine)
- The actual metadata update API endpoints (exist already; this adds validation)
