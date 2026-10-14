import type pkg from 'pg';

/**
 * Idempotency record (Task G2a, ADR-015 D3).
 *
 * Keys are globally unique; replay is bound to the original session +
 * fingerprint. `isExpired` is computed in SQL on the database clock
 * (ADR-015 B34) — never derived from a client-side clock in application
 * code. A record is expired ⟺ `expires_at <= now()`; equality counts as
 * expired.
 */
export interface IdempotencyRecord {
  idempotencyKey: string;
  sessionId: string;
  requestHash: string;
  /** The stored success response data (JSONB). Deep-equal on replay. */
  response: unknown;
  expiresAt: Date;
  isExpired: boolean;
}

export interface NewIdempotencyRecord {
  idempotencyKey: string;
  sessionId: string;
  requestHash: string;
  response: unknown;
  /** Set by the caller (ADR-015: now() + 24h at insert time, in SQL). */
  expiresAt?: Date;
}

/**
 * Persistence port for idempotency keys (Task G2a).
 *
 * Transaction convention follows `SessionRepositoryPort`: when the caller
 * supplies `tx`, the method issues statements only (never BEGIN/COMMIT/
 * ROLLBACK). Expiry is always evaluated in SQL on the database clock.
 */
export interface IdempotencyRepositoryPort {
  /**
   * Pre-transaction / post-rollback lookup (D3 steps 3, D3a). Returns the
   * record only if unexpired; expired records are treated as a miss and
   * are NOT deleted here (reclamation happens in-transaction or by the
   * periodic cleanup — ADR-015 B15).
   */
  findUnexpiredByKey(idempotencyKey: string): Promise<IdempotencyRecord | null>;

  /**
   * In-transaction recheck (D3 step 8). Locks the row (FOR UPDATE) so
   * concurrent reclaimers serialize. Returns the record with `isExpired`
   * computed on the database clock.
   */
  findByKeyForUpdate(
    idempotencyKey: string,
    tx: pkg.PoolClient
  ): Promise<IdempotencyRecord | null>;

  /** Step-16 insert, in the caller's transaction. May raise a unique violation → D3a. */
  insert(record: NewIdempotencyRecord, tx: pkg.PoolClient): Promise<void>;

  /** In-transaction reclamation of an expired record (D3 step 8). */
  deleteByKey(idempotencyKey: string, tx: pkg.PoolClient): Promise<void>;

  /** Periodic cleanup (optimization, not correctness): returns rows deleted. */
  deleteExpired(): Promise<number>;
}
