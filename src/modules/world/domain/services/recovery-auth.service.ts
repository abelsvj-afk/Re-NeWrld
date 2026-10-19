/**
 * RECOV-1: Recovery authorization protocol (ADR-017 §4.3d, design rev 2)
 *
 * Scoped, time-bound authorizations for recovery operations under maintenance fence.
 * Uses clock_timestamp() (real clock) for expiry, not now() (transaction start).
 */

import { randomUUID } from 'node:crypto';
import type pkg from 'pg';
import { withTransaction } from '../../../../shared/database/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecoveryScope = 'repair' | 'restore-reconcile';

export type RecoveryErrorCode =
  | 'FENCE_NOT_ACTIVE'        // 400 - auth only meaningful under fence
  | 'INVALID_DURATION'        // 400 - duration out of range
  | 'AUTHORIZATION_EXISTS'    // 409 - exclusivity guard
  | 'RECOVERY_EXPIRED'        // 403 - auth expired or not found
  | 'RECOVERY_SCOPE_DENIED';  // 403 - wrong scope for operation

export class RecoveryError extends Error {
  public readonly code: RecoveryErrorCode;
  public readonly httpStatus: number;

  constructor(code: RecoveryErrorCode, message: string) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
    this.httpStatus =
      code === 'FENCE_NOT_ACTIVE' || code === 'INVALID_DURATION' ? 400 :
      code === 'RECOVERY_EXPIRED' || code === 'RECOVERY_SCOPE_DENIED' ? 403 : 409;
  }
}

export interface RecoveryDeps {
  isFenceActive: (tx: pkg.PoolClient) => Promise<boolean>;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

export interface RecoveryAuth {
  authId: string;
  scope: RecoveryScope;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Establishment
// ---------------------------------------------------------------------------

/**
 * Establish a recovery authorization.
 * Must be called under active fence. Enforces single active authorization.
 */
export async function establishRecoveryAuth(
  scope: RecoveryScope,
  reason: string,
  durationSeconds: number,
  createdBy: string,
  deps: RecoveryDeps
): Promise<RecoveryAuth> {
  if (durationSeconds <= 0 || durationSeconds > 86400) {
    throw new RecoveryError('INVALID_DURATION', 'Duration must be 1-86400 seconds');
  }

  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);

    // Must be under fence
    if (!(await deps.isFenceActive(tx))) {
      throw new RecoveryError(
        'FENCE_NOT_ACTIVE',
        'Recovery authorization requires active maintenance fence'
      );
    }

    // Close expired authorizations (using real clock)
    await tx.query(
      `DELETE FROM recovery_authorizations WHERE expires_at <= clock_timestamp()`
    );

    // Exclusivity guard: only one active auth at a time
    const existing = await tx.query(
      `SELECT auth_id FROM recovery_authorizations WHERE expires_at > clock_timestamp() LIMIT 1`
    );
    if (existing.rows.length > 0) {
      throw new RecoveryError(
        'AUTHORIZATION_EXISTS',
        `Active recovery authorization already exists: ${existing.rows[0].auth_id}`
      );
    }

    const authId = randomUUID();
    const result = await tx.query(
      `INSERT INTO recovery_authorizations (auth_id, scope, reason, created_by, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 || ' seconds')::interval)
       RETURNING expires_at`,
      [authId, scope, reason, createdBy, durationSeconds.toString()]
    );

    deps.log('info', 'Recovery authorization established', {
      authId, scope, reason, createdBy,
    });

    return {
      authId,
      scope,
      expiresAt: result.rows[0].expires_at,
    };
  });
}

/**
 * Revoke a recovery authorization (L1-held).
 * In-flight transactions will fail at their pre-COMMIT gate.
 */
export async function revokeRecoveryAuth(
  authId: string,
  deps: RecoveryDeps
): Promise<void> {
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
    const result = await tx.query(
      `DELETE FROM recovery_authorizations WHERE auth_id = $1`,
      [authId]
    );
    if (result.rowCount === 0) {
      // Idempotent: already gone
      return;
    }
    deps.log('info', 'Recovery authorization revoked', { authId });
  });
}

// ---------------------------------------------------------------------------
// Verification (BEGIN-gate and pre-COMMIT gate)
// ---------------------------------------------------------------------------

/**
 * Verify a recovery authorization is valid for the given scope.
 * Uses clock_timestamp() (real clock).
 * Throws RecoveryError if invalid, expired, or wrong scope.
 *
 * Call at transaction BEGIN and immediately before COMMIT.
 */
export async function verifyRecoveryAuth(
  authId: string,
  requiredScope: RecoveryScope,
  tx: pkg.PoolClient
): Promise<void> {
  const result = await tx.query(
    `SELECT scope FROM recovery_authorizations
     WHERE auth_id = $1 AND expires_at > clock_timestamp()`,
    [authId]
  );

  if (result.rows.length === 0) {
    throw new RecoveryError(
      'RECOVERY_EXPIRED',
      `Recovery authorization ${authId} not found or expired`
    );
  }

  const actualScope = result.rows[0].scope as RecoveryScope;
  // Strict scope matching: each operation declares its required scope.
  // No implicit superset relationship.
  if (actualScope !== requiredScope) {
    throw new RecoveryError(
      'RECOVERY_SCOPE_DENIED',
      `Authorization scope '${actualScope}' does not match required '${requiredScope}'`
    );
  }
}

/**
 * Check if any active recovery authorization exists.
 * Used by FENCE-1 release gate (criterion 2).
 */
export async function hasActiveRecoveryAuth(tx: pkg.PoolClient): Promise<boolean> {
  const result = await tx.query(
    `SELECT 1 FROM recovery_authorizations WHERE expires_at > clock_timestamp() LIMIT 1`
  );
  return result.rows.length > 0;
}
