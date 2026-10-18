import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { CapacityMetric } from '../../domain/services/reserve-storage.service.js';
import type pkg from 'pg';

/**
 * Production adapter for RES-1a Phase-1 dependencies (ADR-017).
 * These are the real database implementations used by the integration tests
 * and (eventually) the HTTP layer. All functions accept a transaction client.
 */

/** L3: lock the world row FOR UPDATE. Throws if the world does not exist. */
export async function lockWorldRowForUpdate(
  worldId: WorldId,
  tx: pkg.PoolClient
): Promise<void> {
  const result = await tx.query(
    `SELECT world_id FROM worlds WHERE world_id = $1 FOR UPDATE`,
    [worldId.getValue()]
  );
  if (result.rows.length === 0) {
    throw new Error(`world not found: ${worldId.getValue()}`);
  }
}

/** Read the maintenance fence state from the singleton row. */
export async function isFenceActive(tx: pkg.PoolClient): Promise<boolean> {
  const result = await tx.query(
    `SELECT active FROM system_maintenance WHERE id = 1`
  );
  return result.rows[0]?.active === true;
}

/**
 * Activate the maintenance fence. Acquires L1 (per §4.3c, fence transitions
 * serialize through the global media lock), then sets active = true.
 * Used by the operator path and the fence-race integration test.
 */
export async function activateFence(
  tx: pkg.PoolClient,
  reason: string
): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
  await tx.query(
    `UPDATE system_maintenance SET active = true, reason = $1, started_at = now() WHERE id = 1`,
    [reason]
  );
}

/** Deactivate the fence (acquires L1, per §4.3c). */
export async function deactivateFence(tx: pkg.PoolClient): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
  await tx.query(
    `UPDATE system_maintenance SET active = false, reason = '', started_at = null WHERE id = 1`
  );
}

/** Sum of committed (registered) media bytes for a world. */
export async function getRegisteredBytes(
  worldId: WorldId,
  tx: pkg.PoolClient
): Promise<number> {
  const result = await tx.query(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total
     FROM world_media_assets
     WHERE world_id = $1 AND file_confirmed_present = true`,
    [worldId.getValue()]
  );
  return Number(result.rows[0].total);
}

/**
 * Read the cached capacity metric. Returns null if never measured.
 * The metric is written by the periodic capacity job (not part of RES-1a).
 * For now, reads from a simple key-value table; the job creates it.
 */
export async function getCapacityMetric(
  tx: pkg.PoolClient
): Promise<CapacityMetric | null> {
  // The capacity metric table is created by the monitoring slice.
  // For RES-1a integration tests, the test seeds it directly.
  const result = await tx.query(
    `SELECT storage_capacity_bytes, storage_used_bytes,
            active_reservations_at_measure_time, narration_bytes, measured_at
     FROM storage_capacity_metrics
     ORDER BY measured_at DESC LIMIT 1`
  ).catch(() => ({ rows: [] as unknown[] }));
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as {
    storage_capacity_bytes: string;
    storage_used_bytes: string;
    active_reservations_at_measure_time: string;
    narration_bytes: string | null;
    measured_at: Date;
  };
  return {
    storageCapacityBytes: Number(row.storage_capacity_bytes),
    storageUsedBytes: Number(row.storage_used_bytes),
    activeReservationsAtMeasureTime: Number(row.active_reservations_at_measure_time),
    narrationBytes: row.narration_bytes !== null ? Number(row.narration_bytes) : null,
    measuredAt: row.measured_at instanceof Date ? row.measured_at : new Date(row.measured_at),
  };
}
