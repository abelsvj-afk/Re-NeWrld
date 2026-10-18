import {
  StorageReservationRepositoryPort,
  StorageReservation,
  CreateReservationInput,
  StorageReservationState,
} from '../../domain/ports/storage-reservation.repository.port.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { query } from '../../../../shared/database/db.js';
import type pkg from 'pg';

type TxClient = pkg.PoolClient;

interface ReservationRow {
  reservation_id: string;
  world_id: string;
  size_bytes: string;
  state: string;
  epoch: string;
  created_at: Date;
  expires_at: Date;
  released_at: Date | null;
}

/**
 * Postgres adapter for storage reservations (ADR-017 RES-1a).
 * All methods accept an optional transaction client; when provided the
 * caller owns the transaction (BEGIN/COMMIT/ROLLBACK).
 */
export class PostgresStorageReservationRepository implements StorageReservationRepositoryPort {
  public async create(input: CreateReservationInput, tx: TxClient): Promise<StorageReservation> {
    if (input.sizeBytes <= 0) {
      throw new Error('sizeBytes must be positive');
    }
    const result = await tx.query<ReservationRow>(
      `INSERT INTO storage_reservations (world_id, size_bytes, state)
       VALUES ($1, $2, 'RESERVED')
       RETURNING reservation_id, world_id, size_bytes, state, epoch,
                 created_at, expires_at, released_at`,
      [input.worldId.getValue(), input.sizeBytes]
    );
    return this.mapRow(result.rows[0]);
  }

  public async sumActiveBytes(worldId?: WorldId, tx?: TxClient): Promise<number> {
    const sql = worldId
      ? `SELECT COALESCE(SUM(size_bytes), 0) AS total
         FROM storage_reservations
         WHERE world_id = $1 AND released_at IS NULL`
      : `SELECT COALESCE(SUM(size_bytes), 0) AS total
         FROM storage_reservations
         WHERE released_at IS NULL`;
    const params = worldId ? [worldId.getValue()] : [];
    const result = tx
      ? await tx.query<{ total: string }>(sql, params)
      : await query<{ total: string }>(sql, params);
    return Number(result.rows[0].total);
  }

  public async findById(reservationId: string, tx?: TxClient): Promise<StorageReservation | null> {
    const sql =
      `SELECT reservation_id, world_id, size_bytes, state, epoch,
              created_at, expires_at, released_at
       FROM storage_reservations WHERE reservation_id = $1`;
    const result = tx
      ? await tx.query<ReservationRow>(sql, [reservationId])
      : await query<ReservationRow>(sql, [reservationId]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: ReservationRow): StorageReservation {
    return {
      reservationId: row.reservation_id,
      worldId: new WorldId(row.world_id),
      sizeBytes: Number(row.size_bytes),
      state: row.state as StorageReservationState,
      epoch: Number(row.epoch),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
      releasedAt: row.released_at
        ? (row.released_at instanceof Date ? row.released_at : new Date(row.released_at))
        : null,
    };
  }
}
