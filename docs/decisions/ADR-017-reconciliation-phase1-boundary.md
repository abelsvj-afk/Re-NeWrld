# ADR-017 Design Reconciliation: Phase-1 Contract and RES-1a/QUOTA-1 Boundary

**Status:** DRAFT — pending ChatGPT review and product-owner approval.
**Date:** 2026-10-18.
**Resolves:** ChatGPT BLOCK on RES-1a — §5.3 vs §5.5 Phase-1 inconsistency; RES-1a/QUOTA-1 boundary ambiguity.

---

## 1. Problem statement

ADR-017 describes Phase-1 (check-and-reserve) in two places with different contracts:

- **§5.3** specifies: L1 → L2 → L3 locks, per-world quota check (including outstanding reservations), physical capacity check, maintenance-fence check, INSERT reservation, COMMIT.
- **§5.5** specifies: L1 only, metric freshness check, physical capacity check, INSERT reservation, COMMIT. Omits L2, L3, quota check, fence check.

Two implementers following different sections would build different concurrency guarantees. This document establishes the single authoritative contract.

---

## 2. Authoritative Phase-1 contract (supersedes both §5.3 and §5.5 descriptions)

Phase-1 is a **single, short-lived transaction** that atomically decides admission and durably records the reservation. It performs **no filesystem mutation**.

### 2.1 Lock acquisition (strict order per §4.3c)

1. **Level 1** — global media advisory lock: `SELECT pg_advisory_xact_lock(hashtext('media_global'))`.
2. **Maintenance fence check (immediately after L1, before L2/L3):** Call `is_maintenance_active()`. If the fence is active → reject with 503 `FENCE_ACTIVE`, ROLLBACK. Per §4.3c, fence activation/deactivation serializes through L1; checking here ensures no reservation can interleave with a fence transition. The check must occur before any `FOR UPDATE` row lock is acquired.
3. **Level 2** — per-world quota advisory lock: `SELECT pg_advisory_xact_lock(hashtext('media_quota:' || world_id))`.
4. **Level 3** — world row lock: `SELECT ... FOR UPDATE OF worlds WHERE world_id = ?`.

All locks are transaction-scoped (`pg_advisory_xact_lock`). They release on COMMIT or ROLLBACK. Phase-1 holds locks for milliseconds; it never spans the file write.

### 2.2 Admission checks (in order, inside the locked transaction)

The fence check (§2.1 step 2) runs before the remaining checks. The checks below run after L2/L3 are acquired:

1. **Metric freshness:** If the cached capacity metric is stale (older than `STORAGE_METRIC_MAX_AGE_SEC`) → reject with 503 `STORAGE_METRIC_STALE`, ROLLBACK. (Fail-closed per §5.5.)
2. **Narration reserve:** If `narration_bytes >= NARRATION_RESERVE_BYTES` → reject with 503 `NARRATION_CAPACITY_EXCEEDED`, ROLLBACK. (Hard boundary per Addendum 001 §2.3.)
3. **Per-world quota:** Compute `quota_used_bytes(world_id)` = registered media bytes + `active_reservations_bytes(world_id)` (SUM of `storage_reservations.size_bytes` WHERE `world_id = ?` AND `released_at IS NULL`). If `quota_used + incoming_file_size > MEDIA_WORLD_QUOTA_MB` → reject with 507 `QUOTA_EXCEEDED`, ROLLBACK.
4. **Physical capacity:** Compute available bytes live as `storageCapacityBytes - storageUsedBytes - activeReservationsNow`, where `activeReservationsNow` is the live `SUM(size_bytes)` of active reservations (not the cached value). The L1 lock serializes Phase-1 transactions, so the live SUM sees all committed reservations — this is what prevents concurrent oversubscription (S38). If `availableBytes < incoming_file_size` → reject with 507 `STORAGE_FULL`, ROLLBACK. Uses the **media** capacity from Addendum 001 §2.2, not the raw volume size.

### 2.3 Reservation insert and commit

1. INSERT into `storage_reservations`: `world_id`, `size_bytes` (incoming file size as reserved upper bound), `state='RESERVED'`, `expires_at = now() + 5 minutes`, `temp_filename=NULL`.
2. COMMIT. The reservation is now durable and visible to all competitors under READ COMMITTED. All locks release.

### 2.4 Failure semantics

- Any check failure → ROLLBACK, no row inserted, no side effects. Locks release.
- INSERT failure (constraint violation, DB error) → ROLLBACK, propagate as 500. No partial reservation.
- The transaction never leaves a half-created reservation: the INSERT and COMMIT are atomic.

### 2.5 What Phase-1 does NOT do

- No filesystem writes, no temp file creation (that's Phase-2, RES-1b).
- No heartbeat management (RES-1b).
- No expiry or cleanup (RES-1c).
- No asset registry INSERT (that's the Phase-2 commit handoff, covered by QUOTA-1/UPLOAD-1).

---

## 3. RES-1a / QUOTA-1 boundary (authoritative)

### 3.1 RES-1a scope

- `storage_reservations` repository (CRUD, state transitions, `active_reservations_bytes` queries).
- The Phase-1 transaction exactly as specified in §2 above (all locks, fence check, quota input computation, capacity input computation, INSERT, COMMIT, error/rollback behavior).
- Reservation-specific error codes: `QUOTA_EXCEEDED` (507), `STORAGE_FULL` (507), `STORAGE_METRIC_STALE` (503), `FENCE_ACTIVE` (503), `NARRATION_CAPACITY_EXCEEDED` (503).

RES-1a **computes** the quota and capacity inputs needed for its admission decision, but does not own the reusable quota-accounting functions.

### 3.2 QUOTA-1 scope

- Reusable `quota_used_bytes(world_id)` function (registered + reservations, per §5.1).
- `MEDIA_WORLD_QUOTA_MB` configuration wiring.
- API-level quota enforcement integration (the HTTP layer that calls RES-1a's admission and maps errors to status codes).
- Atomic reservation→registry handoff (reservation→COMMITTED + asset INSERT in one transaction) — this is the Phase-2 commit, not Phase-1.

QUOTA-1 **uses** RES-1a's admission transaction; it does not reimplement it. If QUOTA-1 needs quota logic that RES-1a doesn't provide, it extracts it to a shared function rather than duplicating the admission check.

### 3.3 Boundary rule

**The admission decision (checks + INSERT + COMMIT) lives in exactly one place: RES-1a's Phase-1 transaction.** QUOTA-1 integrates with it; it does not replicate it. Any future slice that needs admission uses RES-1a's transaction.

---

## 4. RES-1b and RES-1c (for reference, not in RES-1a scope)

- **RES-1b:** Phase-2 writer obligations — deterministic temp path (`/data/media/.tmp/{reservation_id}.part`), heartbeats with epoch increment, `flock` handshake for chunk writes, safe-open protocol, lock-release ordering on commit/rollback.
- **RES-1c:** Expiry-claim worker — candidate selection (expired, no recent heartbeat), 60s observation window, mtime grace, epoch compare-and-swap, `LOCK_EX|LOCK_NB` fenced claim, ABANDONED transition with audit columns.

These are separate slices with their own acceptance criteria. RES-1a must not silently depend on their behavior.

---

## 5. Test plan for RES-1a (per ChatGPT requirements)

### 5.1 Concurrency and isolation
- Same-world quota contention: two concurrent Phase-1s near quota; exactly one succeeds.
- Different-world capacity contention: concurrent Phase-1s for different worlds against shared physical capacity; no oversubscription.
- Second transaction sees the first's committed reservation (READ COMMITTED visibility).

### 5.2 Boundary conditions
- Exact-boundary admission (quota_used + size == quota → allowed).
- One-byte-over rejection (→ 507 QUOTA_EXCEEDED).
- Reservation larger than remaining quota or capacity → rejected, no row.

### 5.3 Fence
- Fence active at admission → 503 `FENCE_ACTIVE`, no row. The fence check occurs immediately after L1 acquisition and before L2/L3 (per §2.1).
- Fence race: because both Phase-1 and fence activation serialize through the L1 advisory lock, only two orderings are possible. The test must prove both serialized outcomes using explicit coordination (barriers/latches), not an impossible mid-lock interleaving:
  - **Fence wins the race:** Fence activation acquires L1 first and commits. Phase-1 subsequently acquires L1, observes the active fence, and rejects with 503 `FENCE_ACTIVE` before acquiring L2/L3. Assert: no reservation row, no L2/L3 locks were ever held (verify via lock-observation or timing).
  - **Phase-1 wins the race:** Phase-1 acquires L1 first, observes no active fence, proceeds through admission, and commits the reservation. Fence activation subsequently acquires L1 and follows the ADR §4.3d reservation-invalidation contract. Assert: reservation row exists with `state='RESERVED'`; fence activation then marks it per the invalidation rules.
- Do not claim that RES-1a alone guarantees safe Phase-2 writes after the transaction ends; that is a later-slice obligation (RES-1b).

### 5.4 Failure modes
- Stale metric → 503, no row.
- DB failure during INSERT → ROLLBACK, no partial row.
- Rollback after lock acquisition → locks released (verify via subsequent acquisition).
- Two concurrent, one fails → no leaked reservation; locks released on all paths.

### 5.5 Row integrity
- Persisted row has `state='RESERVED'`, `released_at IS NULL`, `size_bytes > 0`, `expires_at` ≈ now+5min.
- Row visible to subsequent transaction.

### 5.6 Explicitly deferred to later slices
- Temp file writes, commit handoff, abandonment, cleanup, full S43 conservation proof (RES-1b/1c, QUOTA-1).
- Phase-2 write safety after Phase-1 commits (RES-1b obligation).

---

## 6. Supersessions

- This document's §2 supersedes the Phase-1 descriptions in ADR-017 §5.3 (steps 1–5) and §5.5 (steps 1–6) for the RES-1a scope. The ADR text remains for historical context but the contract here is authoritative for implementation.
- The RES-1a/QUOTA-1 boundary in §3 supersedes the overlapping descriptions in the implementation breakdown.
