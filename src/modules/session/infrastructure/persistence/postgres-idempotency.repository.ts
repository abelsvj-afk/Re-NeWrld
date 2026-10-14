import type pkg from 'pg';
import {
  IdempotencyRepositoryPort,
  IdempotencyRecord,
  NewIdempotencyRecord,
} from '../../domain/ports/idempotency.repository.port.js';
import { query } from '../../../../shared/database/db.js';

interface IdempotencyRow {
  idempotency_key: string;
  session_id: string;
  request_hash: string;
  response: unknown;
  expires_at: Date;
  is_expired: boolean;
}

/**
 * Postgres adapter for idempotency keys (Task G2a, ADR-015 D3).
 *
 * Expiry predicate (`expires_at <= now()`) is always evaluated in SQL on
 * the database clock (ADR-015 B34) — no client-side clock anywhere.
 * Transaction ownership follows the repository convention: with a caller
 * `tx` this adapter issues statements only.
 */
export class PostgresIdempotencyRepository implements IdempotencyRepositoryPort {
  private mapRow(row: IdempotencyRow): IdempotencyRecord {
    return {
      idempotencyKey: row.idempotency_key,
      sessionId: row.session_id,
      requestHash: row.request_hash,
      response: row.response,
      expiresAt: row.expires_at,
      isExpired: row.is_expired,
    };
  }

  public async findUnexpiredByKey(idempotencyKey: string): Promise<IdempotencyRecord | null> {
    const result = await query<IdempotencyRow>(
      `SELECT idempotency_key, session_id, request_hash, response, expires_at,
              (expires_at <= now()) AS is_expired
       FROM idempotency_keys
       WHERE idempotency_key = $1 AND expires_at > now()`,
      [idempotencyKey]
    );
    if (result.rowCount === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  public async findByKeyForUpdate(
    idempotencyKey: string,
    tx: pkg.PoolClient
  ): Promise<IdempotencyRecord | null> {
    const result = await tx.query<IdempotencyRow>(
      `SELECT idempotency_key, session_id, request_hash, response, expires_at,
              (expires_at <= now()) AS is_expired
       FROM idempotency_keys
       WHERE idempotency_key = $1
       FOR UPDATE`,
      [idempotencyKey]
    );
    if (result.rowCount === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  public async insert(record: NewIdempotencyRecord, tx: pkg.PoolClient): Promise<void> {
    // expires_at defaults to now() + 24h when the caller does not supply it.
    await tx.query(
      `INSERT INTO idempotency_keys
         (idempotency_key, session_id, request_hash, response, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, now() + INTERVAL '24 hours'))`,
      [
        record.idempotencyKey,
        record.sessionId,
        record.requestHash,
        JSON.stringify(record.response),
        record.expiresAt ?? null,
      ]
    );
  }

  public async deleteByKey(idempotencyKey: string, tx: pkg.PoolClient): Promise<void> {
    await tx.query(`DELETE FROM idempotency_keys WHERE idempotency_key = $1`, [
      idempotencyKey,
    ]);
  }

  public async deleteExpired(): Promise<number> {
    const result = await query(
      `DELETE FROM idempotency_keys WHERE expires_at <= now()`
    );
    return result.rowCount ?? 0;
  }
}
