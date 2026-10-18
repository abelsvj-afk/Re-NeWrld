import { WorldId } from '../value-objects/world-id.value-object.js';
import {
  StorageReservationRepositoryPort,
  StorageReservation,
} from '../ports/storage-reservation.repository.port.js';
import { withTransaction } from '../../../../shared/database/db.js';
import type pkg from 'pg';

/** Phase-1 admission error codes (per reconciliation doc §3.1). */
export type ReservationErrorCode =
  | 'FENCE_ACTIVE'
  | 'STORAGE_METRIC_STALE'
  | 'NARRATION_CAPACITY_EXCEEDED'
  | 'QUOTA_EXCEEDED'
  | 'STORAGE_FULL';

export class ReservationRejectedError extends Error {
  public readonly code: ReservationErrorCode;
  public readonly httpStatus: number;
  public readonly retryable: boolean;

  constructor(code: ReservationErrorCode, message: string) {
    super(message);
    this.name = 'ReservationRejectedError';
    this.code = code;
    // 503 for transient/fence conditions, 507 for quota/capacity exhaustion.
    this.httpStatus = code === 'QUOTA_EXCEEDED' || code === 'STORAGE_FULL' ? 507 : 503;
    this.retryable = this.httpStatus === 503;
  }
}

/** Capacity metric snapshot (provided by the periodic job; RES-1a consumes it). */
export interface CapacityMetric {
  /** Configured media capacity in bytes (storage_capacity_bytes). */
  storageCapacityBytes: number;
  /** Measured used bytes at measurement time (storage_used_bytes). */
  storageUsedBytes: number;
  /** Active reservation bytes at measurement time (for staleness adjustment). */
  activeReservationsAtMeasureTime: number;
  /** Measured narration bytes. Null if unknown. */
  narrationBytes: number | null;
  /** When the metric was measured. */
  measuredAt: Date;
}

export interface ReserveStorageDeps {
  reservationRepository: StorageReservationRepositoryPort;
  /** Returns the latest cached capacity metric, or null if never measured. */
  getCapacityMetric: (tx: pkg.PoolClient) => Promise<CapacityMetric | null>;
  /** Returns true if the maintenance fence is active. */
  isFenceActive: (tx: pkg.PoolClient) => Promise<boolean>;
  /** Registered (committed) media bytes for a world. */
  getRegisteredBytes: (worldId: WorldId, tx: pkg.PoolClient) => Promise<number>;
  /** Locks the world row FOR UPDATE; throws if the world does not exist. */
  lockWorldRow: (worldId: WorldId, tx: pkg.PoolClient) => Promise<void>;
  /** Per-world quota in bytes. */
  quotaBytes: number;
  /** Narration reserve in bytes (hard boundary). */
  narrationReserveBytes: number;
  /** Max age of the capacity metric before it is considered stale (ms). */
  metricMaxAgeMs: number;
  /**
   * Test-only hooks. Never set in production. Allows the fence-race
   * integration tests to coordinate with the transaction while it holds L1.
   */
  testHooks?: {
    /** Called (and awaited) immediately after L1 acquisition. */
    onL1Acquired?: () => void | Promise<void>;
  };
}

const LOCK_TIMEOUT = '5s';

/**
 * Phase-1 check-and-reserve (ADR-017 RES-1a).
 *
 * Single authoritative contract per `ADR-017-reconciliation-phase1-boundary.md` §2:
 * L1 → fence check → L2 → L3 → metric freshness → narration reserve →
 * quota check → capacity check → INSERT → COMMIT.
 *
 * No filesystem mutation occurs in this transaction. On any rejection the
 * transaction rolls back with no side effects; locks release automatically.
 */
export async function reserveStorage(
  worldId: WorldId,
  sizeBytes: number,
  deps: ReserveStorageDeps
): Promise<StorageReservation> {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('sizeBytes must be a positive integer');
  }

  return withTransaction(async (tx) => {
    // L1: global media advisory lock.
    await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);

    // Test hook: signal while holding L1 (fence-race coordination).
    if (deps.testHooks?.onL1Acquired) {
      await deps.testHooks.onL1Acquired();
    }

    // Fence check immediately after L1, before L2/L3 (per §4.3c).
    if (await deps.isFenceActive(tx)) {
      throw new ReservationRejectedError('FENCE_ACTIVE', 'Maintenance fence is active; new reservations are rejected.');
    }

    // L2: per-world quota advisory lock.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [
      worldId.getValue(),
    ]);

    // L3: world row lock (also validates the world exists).
    await deps.lockWorldRow(worldId, tx);

    // Metric freshness (fail-closed).
    const metric = await deps.getCapacityMetric(tx);
    if (!metric || Date.now() - metric.measuredAt.getTime() > deps.metricMaxAgeMs) {
      throw new ReservationRejectedError(
        'STORAGE_METRIC_STALE',
        'Capacity metric is stale or unavailable; refusing admission.'
      );
    }

    // Narration reserve (hard boundary per Addendum 001 §2.3).
    if (metric.narrationBytes === null || metric.narrationBytes >= deps.narrationReserveBytes) {
      throw new ReservationRejectedError(
        'NARRATION_CAPACITY_EXCEEDED',
        'Narration storage has reached its reserved capacity; media admissions are paused.'
      );
    }

    // Per-world quota: registered bytes + outstanding reservations.
    const registeredBytes = await deps.getRegisteredBytes(worldId, tx);
    const reservedBytes = await deps.reservationRepository.sumActiveBytes(worldId, tx);
    if (registeredBytes + reservedBytes + sizeBytes > deps.quotaBytes) {
      throw new ReservationRejectedError(
        'QUOTA_EXCEEDED',
        `World quota exceeded: ${registeredBytes + reservedBytes + sizeBytes} > ${deps.quotaBytes} bytes.`
      );
    }

    // Physical capacity: recompute live from the metric components plus
    // current active reservations. The L1 lock serializes Phase-1s, so the
    // live SUM sees all committed reservations (no oversubscription).
    // Formula: capacity - used - active_now, where active_now is live.
    const activeReservationsNow = await deps.reservationRepository.sumActiveBytes(undefined, tx);
    const availableBytes =
      metric.storageCapacityBytes - metric.storageUsedBytes - activeReservationsNow;
    if (availableBytes < sizeBytes) {
      throw new ReservationRejectedError(
        'STORAGE_FULL',
        'Insufficient storage capacity for this upload.'
      );
    }

    // All checks passed — durably record the reservation.
    const reservation = await deps.reservationRepository.create(
      { worldId, sizeBytes },
      tx
    );

    // COMMIT releases L1/L2/L3. The row is now visible to competitors.
    return reservation;
  });
}
