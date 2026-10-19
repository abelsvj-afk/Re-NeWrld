# ADR-017 API-1 Design: API Surface Formalization

**Status:** DRAFT rev 1 — initial design for review
**Date:** 2026-10-19
**Scope:** ADR-017 §4.3a (endpoint error contracts), §4.5 (serving), §9.3 (status codes)

## 1. Objective

Formalize the HTTP API contracts for all ADR-017 endpoints. Most endpoints are already implemented (UPLOAD-1, DEL-1, SHARE-1, DEL-2, RECOV-1); API-1 ensures:
1. Error codes are distinct and never conflated (§9.3)
2. API reference documentation is complete
3. Response shapes are consistent

## 2. Endpoint Contracts

### 2.1 POST /worlds/:id/media (UPLOAD-1)

**Success:** `201 Created`
```json
{
  "url": "/media/{filename}",
  "assetId": "uuid"
}
```

**Errors:**
| Code | HTTP | Meaning |
|------|------|---------|
| `QUOTA_EXCEEDED` | 507 | World quota (50 MB) exceeded |
| `STORAGE_FULL` | 507 | Physical volume full |
| `STORAGE_WRITE_FAILED` | 500 | Filesystem write failed |
| `STORAGE_METRIC_STALE` | 503 | Storage metrics too old |
| `FENCE_ACTIVE` | 503 | Maintenance fence active |
| `INVALID_FILE_TYPE` | 415 | Magic bytes don't match allowed types |
| `FILE_TOO_LARGE` | 413 | Exceeds 10 MB limit |

**§9.3 Distinction Rule:** `QUOTA_EXCEEDED` (logical quota) vs `STORAGE_FULL` (physical capacity) vs `STORAGE_WRITE_FAILED` (I/O error) vs `STORAGE_METRIC_STALE` (observability gap) must never be conflated in logs, metrics, or alerts. Each has a distinct runbook.

### 2.2 DELETE /worlds/:id/media/:assetId (DEL-1)

**Success:** `204 No Content` (idempotent — also returned if already deleted)

**Errors:**
| Code | HTTP | Meaning |
|------|------|---------|
| (404) | 404 | Asset not found (or not in this world) |
| `ASSET_REFERENCED` | 409 | Active references exist; response includes `references: [{role}]` |
| `ASSET_SNAPSHOT_PROTECTED` | 409 | Referenced by published snapshot |
| `DELETION_ABORTED` | 409 | Lifecycle reverted; retry DELETE |
| `FENCE_ACTIVE` | 503 | Maintenance fence active |
| `BACKFILL_IN_PROGRESS` | 503 | Backfill running |

### 2.3 POST /worlds/:id/media/:assetId/share (SHARE-1)

**Success:** `204 No Content`

**Errors:**
| Code | HTTP | Meaning |
|------|------|---------|
| (404) | 404 | Asset or target world not found |
| `NOT_OWNER` | 403 | Only owner can share |
| `SELF_SHARE` | 400 | Cannot share with own world |
| `ALREADY_SHARED` | 409 | Already shared with target |

### 2.4 DELETE /worlds/:id/media/:assetId/share/:targetWorldId (SHARE-1)

**Success:** `204 No Content` (idempotent)

**Errors:**
| Code | HTTP | Meaning |
|------|------|---------|
| (404) | 404 | Asset not found |
| `NOT_OWNER` | 403 | Only owner can unshare |
| `SHARE_REFERENCED` | 409 | Target has active references |

### 2.5 DELETE /worlds/:id (DEL-2)

**Success:** `204 No Content`

**Errors:**
| Code | HTTP | Meaning |
|------|------|---------|
| (404) | 404 | World not found |
| `WORLD_HAS_PUBLISHED_VERSIONS` | 409 | Cannot delete published world |
| `DELETION_IN_PROGRESS` | 409 | Job already running or failed |
| `FENCE_ACTIVE` | 503 | Maintenance fence active |
| `BACKFILL_IN_PROGRESS` | 503 | Backfill running |

### 2.6 GET /media/:filename (SHARE-1 serving)

**Success:** `200 OK` with file bytes

**Errors:**
| Code | HTTP | Meaning |
|------|------|---------|
| (404) | 404 | Not in registry and no file, or lifecycle != active |
| `ASSET_UNAVAILABLE` | 503 | Drift: registry row exists but file missing |

**Headers:**
- `X-Unattributed: true` — file served without registry row (backward compat)

### 2.7 POST /admin/recovery/authorize (RECOV-1)

**Success:** `201 Created`
```json
{
  "authId": "uuid",
  "scope": "repair" | "restore-reconcile",
  "expiresAt": "2026-10-19T03:00:00Z"
}
```

**Errors:**
| Code | HTTP | Meaning |
|------|------|---------|
| `FENCE_NOT_ACTIVE` | 400 | Auth only meaningful under fence |
| `INVALID_DURATION` | 400 | Duration out of range (1-86400s) |
| `AUTHORIZATION_EXISTS` | 409 | Another auth already active |

### 2.8 DELETE /admin/recovery/:authId (RECOV-1)

**Success:** `204 No Content` (idempotent)

## 3. Implementation Tasks

1. **Verify error codes** — Audit all implementations to ensure §9.3 distinction holds:
   - [ ] UPLOAD-1: QUOTA_EXCEEDED vs STORAGE_FULL vs STORAGE_WRITE_FAILED vs STORAGE_METRIC_STALE
   - [ ] DEL-1: ASSET_REFERENCED vs ASSET_SNAPSHOT_PROTECTED vs DELETION_ABORTED
   - [ ] All: FENCE_ACTIVE vs BACKFILL_IN_PROGRESS (never conflated)

2. **API reference docs** — Create `docs/api/media-api.md` with:
   - All endpoints, request/response schemas
   - Error code catalog with runbook links
   - Example requests

3. **Monitoring labels** — Ensure logs/metrics use the exact error codes (not generic "500" or "error")

## 4. Acceptance Criteria

- [ ] S3: DELETE blocked with reference list (verified via contract)
- [ ] S4: Unreferenced delete returns 204, quota reclaimed (verified)
- [ ] S7: Attach of pending_deletion URL → 422 ASSET_DELETED (via REF-1)
- [ ] §9.3: No conflation of QUOTA_EXCEEDED/STORAGE_FULL/STORAGE_WRITE_FAILED/STORAGE_METRIC_STALE in code or docs

## 5. Dependencies

- UPLOAD-1 ✅, DEL-1 ✅, SHARE-1 ✅ (endpoints implemented)
- DEL-2 ✅, RECOV-1 ✅

## 6. Out of Scope

- New endpoints (all already implemented)
- Authentication/authorization changes (existing creatorOnly)
- Rate limiting (separate concern)
