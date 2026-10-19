# ADR-017 QUOTA-1 Design — Quota Admission + Atomic Handoff

**Status:** DRAFT rev 4 — expands schema guard to all five columns
**Date:** 2026-10-18
**Slice order:** After RES-1c (complete). Before UPLOAD-1 + REF-1.
**Change classification:** Level 2 CONFIRMED — schema verified (see §9.4). No migration needed.
**Design gate:** REQUIRED before implementation. No implementation code until explicit DESIGN PASS.

---

## 1. Problem

Per-world storage quota (50 MB, owner-confirmed) must be enforced consistently across every path that consumes bytes. ADR-017 §5.1 defines exactly one quota rule, but the current codebase has the admission logic embedded in RES-1a's transaction with no reusable function, no centralized config, and no atomic handoff from reservation to registry.

**What exists today:**
- RES-1a's `reserve-storage.service.ts` computes `registeredBytes + reservedBytes` inline (lines 143–149) with `quotaBytes` passed as a dependency.
- No `quota_used_bytes(world_id)` function exists as a reusable unit.
- No `MEDIA_WORLD_QUOTA_MB` config wiring exists.
- No reservation→registry handoff exists (that's Phase-2 commit, currently in RES-1b's publication service but not as an atomic quota-handoff primitive).
- `world_media_assets` table: need to verify `lifecycle` and `file_confirmed_present` columns exist.

**What QUOTA-1 must deliver:**
1. Reusable `quota_used_bytes(world_id)` implementing §5.1 exactly.
2. `MEDIA_WORLD_QUOTA_MB` config (default 50, owner-confirmed).
3. API-level quota enforcement integration (HTTP layer calls RES-1a's admission, maps errors).
4. Atomic reservation→registry handoff primitive (reservation→COMMITTED + asset INSERT in one transaction).
5. 10 MB/file limit enforcement (413).

---

## 2. Design Boundary

### 2.1 In scope

| Item | Description |
|------|-------------|
| `quota_used_bytes()` | Single SQL function implementing §5.1: `registered_usage + outstanding_reservations` |
| Config wiring | `MEDIA_WORLD_QUOTA_MB` env var, default 50, validated as positive integer |
| Admission integration | HTTP layer invokes RES-1a's transaction; maps `QUOTA_EXCEEDED` → 507 with `quota_mb`/`used_mb` |
| Atomic handoff | `commitReservationToRegistry()` — single transaction: reservation→COMMITTED + asset INSERT |
| Per-file limit | 10 MB check returning 413 before admission |

### 2.2 Out of scope

- **RES-1a's admission transaction** — QUOTA-1 uses it, does not reimplement it (boundary doc §3.3).
- **Phase-2 writer** (RES-1b) — already implemented.
- **Expiry claim** (RES-1c) — already implemented.
- **Upload path rework** (UPLOAD-1) — consumes QUOTA-1's primitives.
- **Deletion paths** (DEL-1, DEL-2) — consume `quota_used_bytes()` for verification.
- **Reconciliation** (DRIFT-1) — consumes `quota_used_bytes()` for drift detection.
- **Production deployment, backfill, maintenance** — explicitly NOT authorized.

### 2.3 Invariants

1. **Single definition:** `quota_used_bytes()` is the ONLY implementation of §5.1. Every path (admission, delete verification, reconciliation, error responses) calls it. No inline reimplementation.

**B1 resolution — RES-1a integration:** RES-1a's `reserve-storage.service.ts` currently computes `registeredBytes + reservedBytes` inline (lines 143–146). QUOTA-1 extracts this to the shared SQL function. RES-1a's transaction is NOT reimplemented; only the quota-input computation is replaced:

```typescript
// Before (RES-1a inline):
const registeredBytes = await getRegisteredBytes(worldId, tx);
const reservedBytes = await getReservedBytes(worldId, tx);

// After (QUOTA-1):
const usedBytes = await quotaUsedBytes(worldId, tx); // Single SQL function.
if (usedBytes + sizeBytes > deps.quotaBytes) { /* QUOTA_EXCEEDED */ }
```

The admission transaction (locks, fence check, capacity check, INSERT, COMMIT) is unchanged. Only the two inline SUM queries are replaced by one function call. **Regression tests:** RES-1a's existing 14 tests must pass unchanged (they verify the transaction behavior, not the SUM implementation). QUOTA-1 adds a test verifying `quotaUsedBytes()` returns identical results to the old inline computation for a fixture dataset.
2. **Atomic handoff:** The reservation→COMMITTED transition and the registry INSERT commit together. No window where bytes are double-counted or uncounted.
3. **No silent truncation:** If `world_media_assets` lacks `lifecycle` or `file_confirmed_present`, QUOTA-1 fails closed at startup (schema verification), not at request time.
4. **Config immutability:** `MEDIA_WORLD_QUOTA_MB` is read once at startup. Runtime changes require restart (no dynamic reconfiguration).
5. **Per-file limit precedes admission:** The 10 MB check runs before the reservation transaction. A file exceeding the limit never creates a reservation.

---

## 3. Functional Behavior

### 3.1 `quota_used_bytes(world_id)`

```sql
-- Implements ADR-017 §5.1 exactly.
CREATE OR REPLACE FUNCTION quota_used_bytes(p_world_id UUID)
RETURNS BIGINT AS $$
  SELECT
    COALESCE((
      SELECT SUM(size_bytes) FROM world_media_assets
      WHERE world_id = p_world_id
        AND lifecycle IN ('active', 'pending_deletion')
        AND file_confirmed_present = true
    ), 0)
    +
    COALESCE((
      SELECT SUM(size_bytes) FROM storage_reservations
      WHERE world_id = p_world_id
        AND state IN ('RESERVED', 'WRITING')
    ), 0);
$$ LANGUAGE SQL STABLE;
```

**Why a SQL function (not application code):**
- Single definition enforced by the database.
- `STABLE` — safe to call within transactions, no side effects.
- Every consumer (admission, delete, reconciliation) gets identical results.

**Schema precondition:** `world_media_assets` must have `lifecycle` and `file_confirmed_present` columns. Verified at startup; missing columns → fail-closed startup error.

### 3.2 Config: `MEDIA_WORLD_QUOTA_MB`

```typescript
// src/shared/config/quota.ts
const DEFAULT_QUOTA_MB = 50; // Owner-confirmed 2026-10-18.

/**
 * B3: Strict whole-value validation (rev 3: whitespace rejected).
 * - Rejects "50abc", "1.5", "", " 50 ", "\t50".
 * - No trimming: surrounding whitespace is a configuration error, not silently accepted.
 * - Upper bound: 1,000,000 MB (~1 TB). Prevents safe-integer overflow
 *   when converting to bytes (1M * 1024 * 1024 = ~1.05e12, well under 2^53).
 * - Empty string is NOT treated as unset (explicit empty = error).
 */
const MAX_QUOTA_MB = 1_000_000;

export function getWorldQuotaBytes(): number {
  const raw = process.env.MEDIA_WORLD_QUOTA_MB;
  // Unset (undefined) → default. Empty string → error (explicit misconfiguration).
  if (raw === undefined) return DEFAULT_QUOTA_MB * 1024 * 1024;
  // Strict: must be all digits, no whitespace, no decimal, no trailing garbage.
  // Tested against the raw value (not trimmed) — " 50 " is rejected.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `Invalid MEDIA_WORLD_QUOTA_MB: "${raw}" (must be a positive whole number with no whitespace, e.g. "50")`
    );
  }
  const mb = Number(raw);
  if (mb <= 0) {
    throw new Error(`Invalid MEDIA_WORLD_QUOTA_MB: "${raw}" (must be > 0)`);
  }
  if (mb > MAX_QUOTA_MB) {
    throw new Error(
      `Invalid MEDIA_WORLD_QUOTA_MB: "${raw}" (exceeds maximum ${MAX_QUOTA_MB} MB)`
    );
  }
  const bytes = mb * 1024 * 1024;
  // Defense-in-depth: verify safe integer (should be guaranteed by the bound above).
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(`MEDIA_WORLD_QUOTA_MB "${raw}" produces unsafe byte value`);
  }
  return bytes;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file.
```

**Validation:** Called once at startup. Invalid values crash startup (fail-closed), not request handling.

### 3.3 Admission integration

The HTTP upload path calls RES-1a's `reserveStorage()` with `quotaBytes = getWorldQuotaBytes()`. QUOTA-1 does NOT modify the admission transaction — it provides the `quotaBytes` value and maps errors.

**Error mapping (already in RES-1a, verified):**
- `QUOTA_EXCEEDED` → 507 with `quota_mb` and `used_mb` in response body.
- `STORAGE_FULL` → 507 (distinct from `QUOTA_EXCEEDED`).
- `STORAGE_METRIC_STALE` → 503.

**Per-file limit (new in QUOTA-1):**
```typescript
export function checkFileSizeLimit(sizeBytes: number): void {
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new QuotaError('FILE_TOO_LARGE',
      `File size ${sizeBytes} exceeds 10 MB limit.`, 413);
  }
}
```
Called before `reserveStorage()`. Returns 413, not 507.

### 3.4 Atomic handoff: `commitReservationToRegistry()`

```typescript
export interface RegistryHandoffInput {
  reservationId: string;
  worldId: string;
  filename: string;
  url: string;
  mimetype: string;
  sizeBytes: number;
  // ... other asset fields
}

export async function commitReservationToRegistry(
  input: RegistryHandoffInput,
  deps: { withTransaction: ... },
): Promise<{ assetId: string }> {
  return deps.withTransaction(async (tx) => {
    // 1. Transition reservation to COMMITTED.
    // B2: Verify world ownership — the reservation's world_id must match
    // input.worldId. A mismatch indicates a caller bug or confused-deputy
    // attempt to move quota between worlds.
    const res = await tx.query(
      `UPDATE storage_reservations
         SET state = 'COMMITTED', released_at = now()
       WHERE reservation_id = $1
         AND world_id = $2
         AND state IN ('RESERVED', 'WRITING')
       RETURNING reservation_id, world_id, size_bytes`,
      [input.reservationId, input.worldId],
    );
    if (res.rowCount === 0) {
      // Distinguish "not found/wrong world" from "wrong state" for debuggability.
      const check = await tx.query(
        `SELECT world_id, state FROM storage_reservations WHERE reservation_id = $1`,
        [input.reservationId],
      );
      if (check.rowCount === 0) {
        throw new QuotaError('RESERVATION_NOT_FOUND',
          'Reservation does not exist.', 404);
      }
      if (check.rows[0].world_id !== input.worldId) {
        throw new QuotaError('WORLD_MISMATCH',
          'Reservation belongs to a different world.', 403);
      }
      throw new QuotaError('RESERVATION_NOT_ACTIVE',
        `Reservation is in state ${check.rows[0].state}, not committable.`, 409);
    }
    // Verify size matches (defense against caller bugs).
    if (Number(res.rows[0].size_bytes) !== input.sizeBytes) {
      throw new Error('Size mismatch between reservation and handoff input');
    }

    // 2. Insert registry row.
    const asset = await tx.query(
      `INSERT INTO world_media_assets
         (world_id, filename, url, mimetype, size_bytes,
          lifecycle, file_confirmed_present, roles)
       VALUES ($1, $2, $3, $4, $5, 'active', true, '{}')
       RETURNING asset_id`,
      [input.worldId, input.filename, input.url,
       input.mimetype, input.sizeBytes],
    );

    // Both commit together. No double-count, no gap.
    return { assetId: asset.rows[0].asset_id };
  });
}
```

**Why this is atomic:** The `UPDATE` removes bytes from `outstanding_reservations` (state no longer `RESERVED`/`WRITING`) and the `INSERT` adds bytes to `registered_usage` in the same commit. Per §5.1, there is no window where `quota_used_bytes()` double-counts or misses the bytes.

**Failure modes:**
- Reservation not in `RESERVED`/`WRITING` → 409 `RESERVATION_NOT_ACTIVE` (already claimed, abandoned, or committed).
- Size mismatch → hard error (500), indicates caller bug.
- Transaction rollback → reservation unchanged, no registry row. Bytes remain in `outstanding_reservations`.

---

## 4. Transaction / Concurrency Rules

1. **Admission** uses RES-1a's transaction unchanged (L1 global lock → L2 world lock → L3 row lock). QUOTA-1 does not add locks.
2. **Handoff** runs in a single transaction with no advisory locks. The `UPDATE ... WHERE state IN (...)` is the concurrency control — only one handoff can win per reservation (first-writer-wins via row lock).
3. **No nested transactions:** `commitReservationToRegistry()` takes a `withTransaction` dependency; callers must not wrap it in another transaction.
4. **`quota_used_bytes()` is `STABLE`:** safe to call multiple times in a transaction with consistent results.

---

## 5. Observability

| Metric | When incremented |
|--------|------------------|
| `quota_admission_rejected_total{reason="quota_exceeded"}` | 507 `QUOTA_EXCEEDED` |
| `quota_admission_rejected_total{reason="file_too_large"}` | 413 file limit |
| `quota_handoff_total{outcome="committed"}` | Successful handoff |
| `quota_handoff_total{outcome="conflict"}` | 409 `RESERVATION_NOT_ACTIVE` |

Exposed via `/health` `workers.quota` section (consistent with existing `workers` pattern).

**Logging:**
- Admission rejections: `warn` with `worldId`, `requestedBytes`, `usedBytes`, `quotaBytes`.
- Handoff conflicts: `warn` with `reservationId`, `expectedState`.
- Handoff success: `info` with `reservationId`, `assetId`, `sizeBytes`.

---

## 6. Security Implications

1. **Quota evasion:** The `pending_deletion` lifecycle counts toward quota (§5.1). A user cannot evade quota by starting deletion and re-uploading.
2. **Cross-world isolation:** `quota_used_bytes()` filters by `world_id`. No path can query another world's usage.
3. **Integer overflow:** `size_bytes` is `BIGINT`. Sum of 50 MB quota + reservations cannot overflow 64-bit.
4. **Config injection:** `MEDIA_WORLD_QUOTA_MB` is parsed as integer at startup. Non-numeric values crash startup (fail-closed).

---

## 7. Dependencies

### 7.1 On completed work

| Dependency | Status | What QUOTA-1 uses |
|------------|--------|-------------------|
| MIG-0 | Complete | `storage_reservations` table, `world_media_assets` table |
| RES-1a | Accepted | Admission transaction (unchanged) |
| RES-1b | Source-review PASS | Phase-2 writer (handoff integrates at publication) |
| RES-1c | Design + Implementation PASS | Expiry claim (frees quota via ABANDONED) |

### 7.2 Schema verification needed

Before implementation, verify:
- `world_media_assets` has `lifecycle` column (with `'active'`, `'pending_deletion'` values).
- `world_media_assets` has `file_confirmed_present` column (boolean).
- `world_media_assets` has `size_bytes` column.

If any are missing, QUOTA-1 requires a migration (escalates to Level 3).

### 7.3 Downstream consumers (not in scope)

- UPLOAD-1: calls `checkFileSizeLimit()` → `reserveStorage()` → writer → `commitReservationToRegistry()`.
- DEL-1/DEL-2: use `quota_used_bytes()` to verify quota release.
- DRIFT-1: uses `quota_used_bytes()` for reconciliation.

---

## 8. Test Strategy

### 8.1 Unit tests

| Test | Verifies |
|------|----------|
| `quota_used_bytes` SQL | Registered + reservations = total; excludes committed/abandoned; `pending_deletion` counts; missing file doesn't count |
| Config parsing | Default 50 MB; valid override; invalid (0, negative, "50abc", "1.5", "", " 50 ", >1M) throws at startup |
| `checkFileSizeLimit` | 10 MB exactly → pass; 10 MB + 1 → 413 |

### 8.2 Integration tests

| Test | Acceptance criterion |
|------|---------------------|
| **S5:** 45/50 MB used + two concurrent 4 MB uploads | Exactly one proceeds; other gets 507 `QUOTA_EXCEEDED` |
| **S6:** Upload racing deletion | Serializes correctly; no overspend or deadlock |
| **S15:** `pending_deletion` counts | Asset in `pending_deletion` still counts toward quota |
| **S34:** Disk exhausted | 507 `STORAGE_FULL` (distinct from `QUOTA_EXCEEDED`) |
| **S37:** Stale capacity metric | 503 `STORAGE_METRIC_STALE` (fail-closed) |
| Handoff atomicity | Reservation→COMMITTED + asset INSERT in one commit; concurrent handoffs → exactly one wins |
| Handoff idempotency | Second handoff on same reservation → 409, no duplicate asset |

### 8.3 Failure injection

| Case | Expected |
|------|----------|
| Handoff transaction rolls back after UPDATE | Reservation unchanged (`RESERVED`), no asset row, bytes still in outstanding |
| `world_media_assets` missing `lifecycle` column | Startup fails closed with clear error |
| `MEDIA_WORLD_QUOTA_MB=0` | Startup fails closed |
| `MEDIA_WORLD_QUOTA_MB=abc` | Startup fails closed |
| Concurrent handoffs on same reservation | Exactly one commits; other gets 409 |

---

## 9. Schema Verification (B4 — resolved pre-gate)

**Verified 2026-10-18 against `db/migrations/015_media_registry.sql`:**

| Required column | Present? | Definition |
|----------------|----------|------------|
| `world_media_assets.lifecycle` | ✅ Yes | `TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','pending_deletion'))` (line 54-55) |
| `world_media_assets.file_confirmed_present` | ✅ Yes | `BOOLEAN NOT NULL DEFAULT true` (line 58) |
| `world_media_assets.size_bytes` | ✅ Yes | `BIGINT NOT NULL` (line 32) |
| `storage_reservations.state` | ✅ Yes | (migration 015, reservation states) |
| `storage_reservations.size_bytes` | ✅ Yes | (migration 015) |

**Decision:** No schema changes required. QUOTA-1 is confirmed **Level 2**. The `quota_used_bytes()` SQL function is created via application migration (not a schema change to existing tables).

**Startup verification:** On boot, QUOTA-1 executes (scoped to the application's schema):
```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND (
    (table_name = 'world_media_assets'
     AND column_name IN ('lifecycle', 'file_confirmed_present', 'size_bytes'))
    OR
    (table_name = 'storage_reservations'
     AND column_name IN ('state', 'size_bytes'))
  );
```
`current_schema()` resolves to the application's `search_path` schema (typically `public`). A same-named table in another schema cannot satisfy the check. The application verifies all five `(table, column)` pairs are present; if any are missing → startup crashes with `QUOTA_SCHEMA_INCOMPLETE` naming the missing pair (fail-closed). This is defense-in-depth; the migration is the primary guarantee.

**Test:** A test creates the schema without one required column (e.g., drops `storage_reservations.state` in a scratch database) and asserts startup throws `QUOTA_SCHEMA_INCOMPLETE`. A second case drops `world_media_assets.lifecycle`. Both must fail startup; the happy path (all five present) must not.

## 10. Open Questions for Review

1. **Schema:** Does `world_media_assets` already have `lifecycle` and `file_confirmed_present`? (Must verify before implementation.)
2. **Migration:** If schema is incomplete, does QUOTA-1 include the migration or is it a separate slice?
3. **API surface:** DECIDED — `quota_used_bytes()` is internal only. No user-facing quota endpoint in QUOTA-1. If a future slice needs it, that's a separate design.
4. **Metric granularity:** DECIDED — aggregate labels only (`reason`, `outcome`). No `world_id` labels (cardinality risk).

---

## 11. Acceptance Criteria (for DESIGN PASS)

- [ ] `quota_used_bytes()` SQL matches §5.1 exactly (reviewer verifies against ADR text).
- [ ] Boundary with RES-1a is respected: only the SUM computation is extracted, transaction unchanged (B1).
- [ ] Handoff verifies world ownership with distinct 403/404/409 errors (B2).
- [ ] Config parsing rejects "50abc", "1.5", "", " 50 ", and >1M MB (B3).
- [ ] Schema verified pre-gate; Level 2 confirmed, no conditional classification (B4).
- [ ] Startup guard covers all five required columns across both tables; missing column → QUOTA_SCHEMA_INCOMPLETE.
- [ ] Atomic handoff has no double-count or gap window (reviewer verifies transaction logic).
- [ ] All failure modes have defined behavior (table in §3.4).
- [ ] Test strategy covers S5, S6, S15, S34, S37 + handoff atomicity + failure injection.
- [ ] Open questions (§9) are resolved or explicitly deferred.
- [ ] No implementation code is included in this design.

---

**End of QUOTA-1 Design rev 1**
