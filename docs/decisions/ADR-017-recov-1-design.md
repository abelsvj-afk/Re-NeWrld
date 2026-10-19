# ADR-017 RECOV-1 Design: Recovery Authorization Protocol

**Status:** DRAFT rev 2 — self-review fixes (fence check, scope enforcement, writer check)
**Date:** 2026-10-19
**Scope:** ADR-017 §4.3d (recovery protocol steps 1–7), §9.2 step 9, §9.4

## 1. Objective

Define a formal authorization protocol for recovery operations that must run under an active maintenance fence. This allows operators to perform repairs (e.g., DRIFT-1 reconciliation, manual file restoration) without fully releasing the fence.

## 2. Problem

The maintenance fence (FENCE-1) blocks all mutating operations with 503 `FENCE_ACTIVE`. However, some recovery operations must run *during* a fence:
- DRIFT-1 reconciliation (fixing file/row inconsistencies)
- Manual repair of corrupted assets
- Emergency quota adjustments

Without a protocol, operators must either:
1. Release the fence (risky — allows normal traffic during repair), or
2. Bypass the fence (dangerous — no audit trail)

RECOV-1 provides option 3: scoped, time-bound, audited recovery authorization.

## 3. Protocol

### 3.1 Establishment Transaction

An operator requests recovery authorization via a new endpoint:

```
POST /admin/recovery/authorize
{
  "scope": "repair" | "restore-reconcile",
  "reason": "DRIFT-1 reconciliation for world abc",
  "durationSeconds": 3600
}
```

**Steps (in a single transaction):**
1. Acquire L1 (`pg_advisory_xact_lock(hashtext('media_global'))`)
2. Verify fence is active. If not active → 400 `FENCE_NOT_ACTIVE`
   (recovery authorization is only meaningful under a fence; without a fence,
   normal operations are already allowed)
3. Check for existing active authorizations → 409 if one exists (exclusivity guard)
4. Close expired authorizations (using `clock_timestamp()`, not `now()`)
5. INSERT new authorization row:
   ```sql
   INSERT INTO recovery_authorizations
     (auth_id, scope, reason, expires_at, created_by)
   VALUES ($1, $2, $3, clock_timestamp() + ($4 || ' seconds')::interval, $5)
   ```
6. COMMIT

**Returns:** `{ authId, expiresAt }`

### 3.2 Scope Permission Mapping

| Scope | Allowed Operations |
|-------|-------------------|
| `repair` | File restoration, metadata correction, quota adjustment. Cannot delete assets or worlds. |
| `restore-reconcile` | DRIFT-1 reconciliation: file/row sync, orphan cleanup, counter rebuild. Cannot modify user data. |

**Enforcement:** Each recovery operation checks at BEGIN and pre-COMMIT:
```sql
SELECT scope FROM recovery_authorizations
WHERE auth_id = $1 AND expires_at > clock_timestamp()
```
If no row → 403 `RECOVERY_EXPIRED`. If scope doesn't match the operation →
403 `RECOVERY_SCOPE_DENIED`.

**Note:** The protocol verifies the *scope string*. It does NOT automatically
prevent a `repair`-scoped transaction from executing a DELETE. Callers must
validate their operations against the scope before executing. The scope check
is a gate, not a sandbox.

### 3.3 Per-Transaction Lifetime Contract

Every recovery operation runs in a transaction that:
1. **BEGIN-gate:** At transaction start, verify authorization is valid (not expired, correct scope)
2. **Pre-COMMIT gate:** Immediately before COMMIT, re-verify using `clock_timestamp()` (real clock, not transaction start time)
3. **Scope binding:** The transaction records the `auth_id` in its audit log

If the authorization expires mid-transaction → ROLLBACK, return 403 `RECOVERY_EXPIRED`.

**Why `clock_timestamp()`:** `now()` returns transaction start time. If a transaction runs for 2 hours but the auth expired after 1 hour, `now()` would still show valid. `clock_timestamp()` gives the real current time.

### 3.4 Revocation

An operator with L1 can revoke an authorization:

```
DELETE /admin/recovery/:authId
```

**Steps:**
1. Acquire L1
2. DELETE the authorization row
3. COMMIT

In-flight transactions using the revoked auth will fail at their pre-COMMIT gate (the row is gone).

### 3.5 Release Criterion Integration

FENCE-1's release gate (criterion 2) checks:
- No active recovery authorizations exist

The fence cannot be released while a recovery is in progress. This prevents the race where:
1. Operator starts recovery (auth created)
2. Another operator releases fence
3. Normal traffic interferes with recovery

## 4. Writer Exclusion Verification

Before granting authorization, the protocol verifies no writers are active:

```sql
-- Check for active advisory locks (writers hold L1)
-- Note: This is informational only. The real exclusion comes from
-- the L1 acquisition in establishment step 1, which blocks until
-- any current L1 holder commits.
SELECT count(*) FROM pg_locks WHERE locktype = 'advisory';
```

If writers are active → 409 `WRITERS_ACTIVE`, retry after they complete.

**Note:** This is a best-effort check. The L1 acquisition in step 1 of establishment provides the real exclusion — if a writer holds L1, the establishment transaction blocks until the writer commits.

## 5. Database Schema

**Migration 025_recovery_authorizations.sql:**
```sql
CREATE TABLE IF NOT EXISTS recovery_authorizations (
  auth_id UUID PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('repair', 'restore-reconcile')),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,  -- operator identifier
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_auth_expires ON recovery_authorizations(expires_at);
```

## 6. Acceptance Criteria

- [ ] S60: Repair under active fence via authorization; failure keeps fence
- [ ] S61: Establishment concurrency, crash, expiry
- [ ] S62: Expiry mid-procedure boundary (real clock via `clock_timestamp()`)
- [ ] S63: True-clock gate + revocation race (revoke during transaction → pre-COMMIT fails)
- [ ] S64: Close-expired on true clock after lock wait
- [ ] S65: Fence release mid-wait → clean abort, zero row changes
- [ ] S67: Wrong-scope operations denied (403 `RECOVERY_SCOPE_DENIED`)

## 7. Dependencies

- MIG-0 ✅ (base tables)
- FENCE-1 (partial) — needs the fence check integration

## 8. Out of Scope

- DRIFT-1 (uses this protocol, but separate slice)
- API-1 (formalizes the admin endpoints)
- Actual repair operations (defined by callers)

## 9. Security Considerations

- The `/admin/recovery/*` endpoints require admin authentication (not just creator)
- All authorizations are logged with operator identity and reason
- Authorizations are time-bound (max 24 hours)
- Only one active authorization at a time (exclusivity guard)
