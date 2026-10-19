# ADR-017 REF-1 Design: Reference Validation Contract

**Status:** DRAFT rev 1 — awaiting design review
**Date:** 2026-10-18
**Scope:** §4.2b transaction contract on every reference-setting path

## 1. Objective

Implement the authoritative reference validation contract that ensures every URL stored in scene/world metadata resolves to a valid, active, present registry row before the reference is committed.

## 2. Reference-Setting Paths (§4.2 Canonical Paths Table)

| Path | Operation | Validation Point |
|------|-----------|------------------|
| Scene metadata update | `scene.metadata.illustrationUrl` set | Before metadata commit |
| World metadata update | `world.metadata.coverArtUrl` set | Before metadata commit |
| Publish (snapshot creation) | Snapshot pins current URLs | During publish transaction |
| Replacement T2 | Metadata switch to new URL | During T2 transaction |

## 3. Validation Contract (§4.2b)

### 3.1 Transaction Requirements

- **Locks first, scan second:** Acquire all required locks before scanning references
- **Isolation:** `READ COMMITTED`
- **Atomicity:** URL resolution + validation + metadata write in single transaction

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

### 3.4 Roles Atomicity

The `roles` array update (adding/removing the URL's role) must be atomic with the URL write:
- Adding a cover art URL → `roles` gains `'cover'`
- Removing a URL → `roles` loses that role
- Both happen in the same transaction as the metadata update

This prevents the S24 failure mode (roles corrupted by failed replacement).

## 4. Cross-World References (S18)

Per §4.7c: a world may reference an asset owned by another world if:
1. The asset's `shared_with_worlds` array contains the referencing world's ID, OR
2. The asset is being shared via the SHARE-1 flow

Validation must NOT return 422 `ASSET_WRONG_WORLD` for valid shared references. The check is:
```sql
WHERE (world_id = $requesting_world_id 
   OR $requesting_world_id = ANY(shared_with_worlds))
```

## 5. Backfill Freeze (§4.7b)

When `backfill_runs` has an `in_progress` row:
- Reference-setting operations return 503 `BACKFILL_IN_PROGRESS`
- This prevents metadata from referencing assets whose registry rows may be incomplete

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

## 9. Out of Scope

- SHARE-1 implementation (shared asset lifecycle)
- DEL-1 implementation (deletion state machine)
- Snapshot reference population (SHARE-1)
- The actual metadata update API endpoints (exist already; this adds validation)
