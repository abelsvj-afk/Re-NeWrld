# ADR-017 SHARE-1 Design: Shared Assets, Snapshot References, Serving Layer

**Status:** DRAFT rev 2 — self-review fixes (snapshot SQL, DEL-1 integration, serving context)
**Date:** 2026-10-19
**Scope:** ADR-017 §4.1 (snapshot refs), §4.5 (serving), §4.7c (shared contract)

## 1. Objective

Enable cross-world asset sharing and ensure published snapshots keep their media references even after draft assets are replaced or deleted.

Three sub-features:
1. **Snapshot references** — `asset_snapshot_references` table populated at publish time
2. **Shared assets** — `shared_with_worlds` array for cross-world access
3. **Registry-gated serving** — `GET /media/{filename}` checks registry before serving

## 2. Snapshot References

### 2.1 Table

```sql
CREATE TABLE asset_snapshot_references (
  snapshot_id UUID NOT NULL,
  asset_id UUID NOT NULL REFERENCES world_media_assets(asset_id),
  role TEXT NOT NULL,  -- 'cover' | 'illustration'
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (snapshot_id, asset_id, role)
);
```

### 2.2 Population at Publish Time

When `POST /worlds/:id/publish` creates a snapshot:
1. In the publish transaction, after snapshot row is created
2. Scan the world's current references (same query as DEL-1 T1 step 7)
3. For each referenced asset, INSERT into `asset_snapshot_references`

```sql
-- Cover (single row)
INSERT INTO asset_snapshot_references (snapshot_id, asset_id, role)
SELECT $1, asset_id, 'cover' FROM world_media_assets
WHERE url = (SELECT metadata->>'coverArtUrl' FROM worlds WHERE world_id = $2)
  AND (SELECT metadata->>'coverArtUrl' FROM worlds WHERE world_id = $2) IS NOT NULL
ON CONFLICT DO NOTHING;

-- Illustrations (multiple rows)
INSERT INTO asset_snapshot_references (snapshot_id, asset_id, role)
SELECT DISTINCT $1, a.asset_id, 'illustration'
FROM world_media_assets a
JOIN scenes s ON s.world_id = $2 AND s.metadata->>'illustrationUrl' = a.url
ON CONFLICT DO NOTHING;
```

### 2.3 Protection Semantics

- An asset with rows in `asset_snapshot_references` CANNOT be deleted
- DEL-1's T1 reference scan (step 7) expands with a third UNION branch:
  ```sql
  SELECT 'snapshot' AS role FROM asset_snapshot_references WHERE asset_id = $1
  ```
  ($1 = asset_id, not URL — snapshot refs are by ID)
- If snapshot refs exist → 409 `ASSET_SNAPSHOT_PROTECTED` (new error code)
- **Note:** The snapshot check uses `asset_id` directly, not the URL. The other
  two branches use URL matching. This is intentional: snapshots pin specific
  asset versions by ID, while draft references are by URL (mutable).

### 2.4 Backfill

Existing published snapshots need their references populated:
- Migration script scans all snapshots, populates `asset_snapshot_references`
- Must handle snapshots whose referenced assets no longer exist (skip, log warning)
- G3 scoping: only populate for snapshots in the current generation

## 3. Shared Assets

### 3.1 Schema

Add to `world_media_assets`:
```sql
ALTER TABLE world_media_assets
ADD COLUMN shared_with_worlds UUID[] DEFAULT '{}';
```

### 3.2 Operations

**Share:** `POST /worlds/:id/media/:assetId/share` with `{ targetWorldId }`
- Owner world adds target to `shared_with_worlds`
- Target world can now reference the asset (REF-1 allows cross-world for shared assets)

**Unshare:** `DELETE /worlds/:id/media/:assetId/share/:targetWorldId`
- Removes target from array
- If target has active references → 409 `ASSET_REFERENCED` (must detach first)

**Owner transfer:** When owner world is deleted (DEL-2), shared assets transfer to first world in `shared_with_worlds` (eager transfer).

### 3.3 REF-1 Update

`validateAssetUrl` currently rejects cross-world refs with `ASSET_WRONG_WORLD`. After SHARE-1:
- If `asset.world_id != requesting_world_id` AND `requesting_world_id = ANY(shared_with_worlds)` → ALLOW
- Otherwise → still reject with `ASSET_WRONG_WORLD`

### 3.4 DEL-1 Update

DEL-1's T1 reference scan must also check `shared_with_worlds`:
- If asset is shared and any shared world has active references → 409 `ASSET_REFERENCED`
- Owner cannot delete a shared asset with active shared references

## 4. Registry-Gated Serving

### 4.1 Current State

`GET /media/{filename}` is served by Fastify static file handler (see `src/app.ts`),
serving directly from disk without checking the registry. SHARE-1 replaces this
with a registry-gated route handler.

### 4.2 New Behavior

```
GET /media/{filename}
1. Look up asset by URL (`/media/{filename}`) in `world_media_assets`
2. If not found → check unattributed files (see 4.3) → if not found → 404
3. If found but `lifecycle != 'active'` → 404 (don't serve deleted/pending assets)
4. If found and active → serve file
5. If file missing on disk but row exists → 503 (drift detected, trigger alert)
```

### 4.3 Unattributed Files

Files in `/data/media/` without a registry row (e.g., from before MIG-0, or orphaned):
- Served with a warning header (`X-Unattributed: true`)
- Logged for DRIFT-1 reconciliation
- This preserves backward compatibility for existing files

### 4.4 Shared Asset Authorization

When serving a shared asset:
- The request context includes the world (from auth or query param)
- If asset's `world_id != context_world_id`:
  - Check `context_world_id = ANY(shared_with_worlds)`
  - If not shared → 403 Forbidden
  - If shared → serve (log access)

## 5. F1/F2/F3 Cascade Replacements

When an asset is replaced (new upload with same role):
- **F1:** Old asset loses the role, new asset gains it (role transfer)
- **F2:** If old asset has no other roles and no snapshot refs → auto-delete old asset
- **F3:** If old asset has snapshot refs → keep old asset (snapshot protected), just remove the role

This is implemented in the UPLOAD-1 flow when setting cover/illustration URLs.

## 6. Acceptance Criteria

- [ ] S1: Published version keeps old image after draft replacement
- [ ] S2: Detach from draft preserves published snapshot reference
- [ ] S19: Dual-role backfill + independent role replacement
- [ ] S46: Shared ownership lifecycle (17 steps)
- [ ] S56: Serving during unresolved `missing_row` drift
- [ ] S58: NULL-world snapshot reference protected, servable, drift-repairable
- [ ] S49: G3 — new-file collision aborts; transfers exempt
- [ ] S50: Backfill populates snapshot refs, no false drift

## 7. Dependencies

- MIG-0 ✅ (base tables)
- REF-1 ✅ (reference validation — needs update for shared assets)
- DEL-1 ✅ (deletion — needs update for snapshot protection)
- QUOTA-1 ✅ (shared assets count toward owner's quota only, not borrowers')

## 8. Out of Scope

- DEL-2 (world deletion with shared asset transfer — uses SHARE-1 contracts)
- DRIFT-1 (orphan reconciliation — uses serving layer signals)
- API-1 (formalizes the share/unshare endpoints)

## 9. Migration Plan

1. **021_snapshot_references.sql** — Create `asset_snapshot_references` table
2. **022_shared_worlds.sql** — Add `shared_with_worlds` column
3. Backfill script for existing snapshots (run manually, not in migration)
