# ADR-017 UPLOAD-1 Design: Upload Path Rework

**Status:** DRAFT rev 4 — fixes allowance lifecycle + fence rule
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

### 3.1 File Size Determination (addresses review: reservation ordering)

**Problem:** `reserveStorage(worldId, sizeBytes)` needs an exact byte count, but multipart streams don't provide trustworthy `Content-Length` (client-supplied, may be absent or lie).

**Solution:** Two-phase size determination:
1. Stream the upload to a staging temp file (`/data/media/.staging/{uuid}.tmp`) with NO size limit except the 10 MB multipart cap.
2. `fstat()` the staged file for the exact byte count.
3. Call `reserveStorage(worldId, actualSizeBytes)` with the measured size.
4. If reservation succeeds, proceed to Phase-2 (move staged file to `.tmp/{reservation_id}.part`).
5. If reservation fails (quota/storage), delete the staged file synchronously.

This never trusts client metadata and never buffers unboundedly (multipart cap is 10 MB).

### 3.2 Failure Handling

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

### 3.7 Fence Semantics (rev 4: single enforceable rule)

**Rule:** The fence takes effect at Phase-2 write time, not at reservation time.

**Enforceable invariant:**
- **Phase-1 (reservation):** If fence is active when `reserveStorage()` is called → 503 `FENCE_ACTIVE`. No reservation created.
- **Phase-2 (writes):** Every chunk write performs the fenced check (per RES-1b: `flock LOCK_SH` → verify reservation still valid → write). If fence was activated AFTER reservation but BEFORE a chunk write → the fenced check fails → write rejected with `FENCE_ACTIVE`.
- **Already-written chunks:** Not rolled back. The reservation remains; the upload is incomplete.
- **Phase-A (commit):** Requires all chunks written. If fence blocked some chunks, Phase-A cannot complete (missing data).

**What this means:**
- An upload admitted before fence activation does NOT automatically complete.
- It completes ONLY if all Phase-2 writes finished before the fence activated.
- If the fence activates mid-upload, remaining chunks are rejected. The partial upload expires via RES-1c.

**Writer check (per chunk):**
```
1. Acquire LOCK_SH on .part file
2. SELECT state FROM storage_reservations WHERE reservation_id = $1
3. SELECT active FROM system_maintenance WHERE id = 1  -- fence check
4. If fence active → release lock, throw FENCE_ACTIVE
5. If reservation not in (RESERVED, WRITING) → release lock, throw
6. Write chunk, release lock
```

**No contradiction:** The reservation is not "aborted" — it simply cannot make progress while the fence is active. This is the same as RES-1b's fenced writes. The fence is enforced at the point of filesystem mutation, which is the correct safety boundary.

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
