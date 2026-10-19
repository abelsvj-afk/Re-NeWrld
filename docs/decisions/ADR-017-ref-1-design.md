# ADR-017 REF-1 Design: Reference Validation Contract

**Status:** DRAFT rev 4 — resolves cross-world + lock ordering
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
4. **Asset row locks (rev 4: explicit ordering requirement):**
   
   **MANDATORY SEQUENCE:** All affected asset rows MUST be locked in ascending `asset_id` order BEFORE scanning references or modifying roles. No exceptions.
   
   - **Replacement** (URL A → URL B): 
     1. Determine asset_id for A and B
     2. Lock smaller asset_id first, then larger
     3. Then scan reference graph
     4. Then update roles for both
   - **Removal** (URL A → null):
     1. Lock asset A row
     2. Scan, update roles
   - **New reference** (null → URL B):
     1. Lock asset B row  
     2. Scan, update roles
   
   **The transaction MUST follow this exact sequence:**
   1. Acquire L1, L2, world row lock (steps 1-3 above)
   2. Identify all affected asset_ids (old and new)
   3. Sort asset_ids ascending
   4. Lock each in order via `SELECT ... FOR UPDATE`
   5. ONLY THEN: scan reference graph
   6. ONLY THEN: update roles and metadata
   
   **Violation = bug:** If code scans or modifies before all locks are held, it violates the contract. This is enforced by code review, not by the database.

**Why both rows:** Replacement affects the `roles` of both the old asset (may lose a role) and the new asset (gains a role). Both must be locked before scanning the reference graph, otherwise a concurrent transaction could interleave and corrupt `roles`.

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
1. Before the metadata update, scan ALL registered reference paths (see §3.4a below).
2. Compute the set of roles still needed AFTER the proposed change.
3. Update `world_media_assets.roles` to exactly that set.

### 3.4a Reference-Path Registry (addresses review)

**Authoritative list** (the ONLY fields that can hold asset URLs):

| Table | Field (JSON path) | Role value |
|-------|-------------------|------------|
| `worlds` | `metadata->>'coverArtUrl'` | `'cover'` |
| `scenes` | `metadata->>'illustrationUrl'` | `'illustration'` |

**Adding a new reference path requires:**
1. Add row to the table above (in this design doc)
2. Add the field to the scan query in the validator
3. Add a test that sets the new field and verifies `roles` includes the role
4. Update the `roles` CHECK constraint if new role values are introduced

**No other fields may hold asset URLs.** If code writes a URL to an unregistered field, the validator will not track it, and `roles` will be incorrect. This is a design invariant, enforced by code review.

**Why a closed list:** An open-ended "any other reference paths" allows silent drift. Every reference path must be explicitly registered, tested, and reviewed.

**Example:**
- Asset A has `roles = ['cover', 'illustration']` (referenced by world cover + scene 5)
- User removes world cover → new roles = `['illustration']` (scene 5 still needs it)
- User removes scene 5 illustration → new roles = `[]`

This is computed from the actual reference graph, not by blindly adding/removing. The S24 failure mode (roles corrupted) is prevented because the roles always reflect reality.

### 3.4b Role Scope Invariant (addresses review)

**Before SHARE-1 (current):**
- `roles` is derived ONLY from references within the asset's owning world.
- Cross-world references are rejected (422 `ASSET_WRONG_WORLD`), so they cannot contribute to `roles`.
- **Invariant:** `roles` = union of roles from `worlds` (owner) + `scenes` (owner's scenes).

**After SHARE-1:**
- `roles` is derived from EVERY permitted reference to the asset, across all worlds.
- If world W2 references asset owned by W1 (via `shared_with_worlds`), and the reference has role `'cover'`, then asset's `roles` includes `'cover'`.
- **Invariant:** `roles` = union of roles from all worlds with valid references.

**Transition:** When SHARE-1 is implemented, the validator's scan query expands to include cross-world references. The `roles` update logic is unchanged (still union semantics); only the scan scope widens.

**Why this matters:** If `roles` only tracked the owning world's references, a shared asset could have `roles = []` while W2 actively uses it as cover art. Deletion logic (DEL-1) checks `roles` to determine if an asset is referenced — an incomplete `roles` would allow deletion of an in-use shared asset.

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
- [ ] S18-DEFERRED: Cross-world shared references (SHARE-1 scope, not REF-1)
- [ ] Cross-world URLs rejected with 422 `ASSET_WRONG_WORLD` (REF-1 fail-closed behavior)
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
