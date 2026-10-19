# Re:NeWrld Media API Reference (ADR-017)

This document describes the HTTP API for media asset management (upload, deletion, sharing, serving).

## Authentication

All endpoints require creator authentication via session cookie (`rene_session_id`).

## Endpoints

### POST /worlds/:id/media

Upload a new media asset (cover art or scene illustration).

**Request:** `multipart/form-data` with file field.

**Success (201):**
```json
{
  "url": "/media/{filename}",
  "assetId": "123e4567-e89b-12d3-a456-426614174000"
}
```

**Errors:**
| HTTP | Code | Meaning | Runbook |
|------|------|---------|---------|
| 413 | `FILE_TOO_LARGE` | File exceeds 10 MB | Client must compress/resize |
| 415 | `INVALID_FILE_TYPE` | Magic bytes not JPEG/PNG/WebP/GIF | Client must send valid image |
| 503 | `FENCE_ACTIVE` | Maintenance in progress | Retry after fence released |
| 503 | `STORAGE_METRIC_STALE` | Storage metrics outdated | Alert ops; check storage health |
| 507 | `QUOTA_EXCEEDED` | World quota (50 MB) exceeded | Delete unused assets or request increase |
| 507 | `STORAGE_FULL` | Physical volume full | Alert ops; add capacity |
| 500 | `STORAGE_WRITE_FAILED` | Filesystem I/O error | Alert ops; check disk health |

**§9.3 Note:** `QUOTA_EXCEEDED` (logical), `STORAGE_FULL` (physical), `STORAGE_WRITE_FAILED` (I/O), and `STORAGE_METRIC_STALE` (observability) are distinct. Never conflate in logs or alerts.

---

### DELETE /worlds/:id/media/:assetId

Delete a media asset. Blocked if referenced.

**Success (204):** No content. Idempotent — also 204 if already deleted.

**Errors:**
| HTTP | Code | Meaning |
|------|------|---------|
| 404 | — | Asset not found (or not in this world) |
| 409 | `ASSET_REFERENCED` | Active references exist. Response includes `references: [{role}]` |
| 409 | `ASSET_SNAPSHOT_PROTECTED` | Referenced by published snapshot; cannot delete |
| 409 | `DELETION_ABORTED` | Lifecycle reverted; retry the DELETE |
| 503 | `FENCE_ACTIVE` | Maintenance in progress |
| 503 | `BACKFILL_IN_PROGRESS` | Backfill running |

---

### POST /worlds/:id/media/:assetId/share

Share an asset with another world.

**Request:**
```json
{
  "targetWorldId": "123e4567-e89b-12d3-a456-426614174000"
}
```

**Success (204):** No content.

**Errors:**
| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `SELF_SHARE` | Cannot share with own world |
| 403 | `NOT_OWNER` | Only owning world can share |
| 404 | — | Asset or target world not found |
| 409 | `ALREADY_SHARED` | Already shared with target |

---

### DELETE /worlds/:id/media/:assetId/share/:targetWorldId

Remove sharing. Blocked if target has active references.

**Success (204):** No content. Idempotent.

**Errors:**
| HTTP | Code | Meaning |
|------|------|---------|
| 403 | `NOT_OWNER` | Only owning world can unshare |
| 404 | — | Asset not found |
| 409 | `SHARE_REFERENCED` | Target world has active references |

---

### DELETE /worlds/:id

Delete a world (draft-only). Uses T1-T5 state machine.

**Success (204):** No content.

**Errors:**
| HTTP | Code | Meaning |
|------|------|---------|
| 404 | — | World not found |
| 409 | `WORLD_HAS_PUBLISHED_VERSIONS` | Cannot delete published world |
| 409 | `DELETION_IN_PROGRESS` | Job already running or failed |
| 503 | `FENCE_ACTIVE` | Maintenance in progress |
| 503 | `BACKFILL_IN_PROGRESS` | Backfill running |

---

### GET /media/:filename

Serve a media file. Registry-gated.

**Success (200):** File bytes with appropriate `Content-Type`.

**Headers:**
- `X-Unattributed: true` — file has no registry row (backward compat)

**Errors:**
| HTTP | Code | Meaning |
|------|------|---------|
| 404 | — | Not in registry, or lifecycle != active |
| 503 | `ASSET_UNAVAILABLE` | Drift: registry row exists but file missing |

---

### POST /admin/recovery/authorize

Establish recovery authorization (under active fence).

**Request:**
```json
{
  "scope": "repair" | "restore-reconcile",
  "reason": "DRIFT-1 reconciliation for world abc",
  "durationSeconds": 3600
}
```

**Success (201):**
```json
{
  "authId": "123e4567-e89b-12d3-a456-426614174000",
  "scope": "repair",
  "expiresAt": "2026-10-19T03:00:00Z"
}
```

**Errors:**
| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `FENCE_NOT_ACTIVE` | Auth only meaningful under fence |
| 400 | `INVALID_DURATION` | Duration must be 1-86400 seconds |
| 409 | `AUTHORIZATION_EXISTS` | Another auth already active |

---

### DELETE /admin/recovery/:authId

Revoke recovery authorization. Idempotent.

**Success (204):** No content.

---

## PATCH /worlds/:id and PATCH /worlds/:id/scenes/:sceneId

When `metadata.coverArtUrl` or `metadata.illustrationUrl` is set, the URL is validated:

**Errors:**
| HTTP | Code | Meaning |
|------|------|---------|
| 422 | `ASSET_UNKNOWN` | URL not in registry |
| 422 | `ASSET_DELETED` | Asset lifecycle != active |
| 422 | `ASSET_FILE_MISSING` | File not confirmed present |
| 422 | `ASSET_WRONG_WORLD` | Asset belongs to different world and not shared |
| 503 | `BACKFILL_IN_PROGRESS` | Backfill running |

## Error Code Catalog

### Quota & Storage (§9.3)
- `QUOTA_EXCEEDED` (507): Logical per-world quota (50 MB). Runbook: delete unused assets.
- `STORAGE_FULL` (507): Physical volume capacity. Runbook: alert ops, add capacity.
- `STORAGE_WRITE_FAILED` (500): Filesystem I/O error. Runbook: alert ops, check disk.
- `STORAGE_METRIC_STALE` (503): Metrics outdated. Runbook: alert ops, check storage health.

These four are **never conflated**. Each has a distinct cause and runbook.

### References
- `ASSET_UNKNOWN` (422), `ASSET_DELETED` (422), `ASSET_FILE_MISSING` (422), `ASSET_WRONG_WORLD` (422)
- `ASSET_REFERENCED` (409), `ASSET_SNAPSHOT_PROTECTED` (409)

### Fence & Backfill
- `FENCE_ACTIVE` (503): Maintenance fence. Retry after release.
- `BACKFILL_IN_PROGRESS` (503): Backfill running. Retry after complete.

These two are **distinct**: fence is operator-controlled; backfill is a background job.
