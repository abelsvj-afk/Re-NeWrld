# ADR-017 UPLOAD-1 Design: Upload Path Rework

**Status:** DRAFT rev 1 — awaiting design review
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
1. Validate: mimetype via magic bytes (not extension) → 415 on invalid
2. Check: backfill freeze → 503 BACKFILL_IN_PROGRESS
3. Check: maintenance fence (under L1) → 503 FENCE_ACTIVE / MAINTENANCE_MODE
4. Check: file size → 413 FILE_TOO_LARGE (via checkFileSizeLimit)
5. Phase-1: reserveStorage(worldId, sizeBytes) → 507 QUOTA_EXCEEDED / STORAGE_FULL
6. Phase-2: Phase2Writer writes chunks to /data/media/.tmp/{reservation_id}.part
7. Fsync: file → rename to final → fsync directory
8. Phase-A: commitReservationToRegistry() → asset PENDING + reservation COMMITTED
9. Phase-B/C: publication.service handles link + activation
10. Return 201 with registry URL
```

### 3.1 Failure Handling

| Failure Point | Behavior |
|---------------|----------|
| Magic bytes invalid | 415, no reservation created |
| Backfill freeze active | 503 BACKFILL_IN_PROGRESS, no reservation |
| Fence active | 503 FENCE_ACTIVE, no reservation |
| File too large | 413 FILE_TOO_LARGE, no reservation |
| Quota exceeded | 507 QUOTA_EXCEEDED (from reserveStorage) |
| Storage full | 507 STORAGE_FULL (from reserveStorage) |
| Phase-2 write fails | Reservation expires (RES-1c reaps), temp cleaned |
| Phase-A commit fails | Reservation remains, expires via RES-1c |
| Row insert fails after file written | Orphan compensation: synchronous delete + 500 |

### 3.2 Magic Bytes Validation

Replace extension-based mimetype check with magic bytes:
- JPEG: `FF D8 FF`
- PNG: `89 50 4E 47 0D 0A 1A 0A`
- WebP: `RIFF....WEBP`
- GIF: `GIF87a` or `GIF89a`

Read first 12 bytes, validate before Phase-1. Returns 415 on mismatch.

### 3.3 Backfill Freeze Check

Per §4.7: when backfill is `in_progress`, new uploads that would create registry rows must be rejected with 503 `BACKFILL_IN_PROGRESS`. Check via `backfill_runs` table (single-active-run constraint).

### 3.4 Integration with Existing Slices

- **RES-1a:** `reserveStorage()` for Phase-1 (already implemented)
- **RES-1b:** `Phase2Writer` for chunked writes, `phaseACommit` → `commitReservationToRegistry` for Phase-A
- **QUOTA-1:** `checkFileSizeLimit()`, `quotaUsedBytes()` (via reserveStorage), `commitReservationToRegistry()`
- **FENCE-1:** `isFenceActive()` check (already wired in reserveStorage)

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

### Backward Compatibility

Per breakdown: "Existing route behavior preserved for the pre-backfill grace period." The old direct-write path remains as fallback until backfill completes. Feature flag `USE_ADR017_UPLOAD` controls which path executes.

## 5. Acceptance Criteria

- [ ] S8: Failed metadata switch → orphan recovery path exercised
- [ ] S23: Same bytes, different filenames → two rows, never merged
- [ ] S24: Failed replacement does not corrupt roles
- [ ] Magic bytes validation rejects mismatched content with 415
- [ ] Backfill freeze returns 503 before Phase-1
- [ ] All existing quota/reservation error codes preserved
- [ ] 201 response includes both `url` and `assetId`

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
