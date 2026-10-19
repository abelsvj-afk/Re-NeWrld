/**
 * QUOTA-1: Atomic reservation→registry handoff (ADR-017 §5.1, design rev 8)
 *
 * Phase A of the Phase-2 commit: reservation→COMMITTED + asset INSERT (PENDING)
 * in a single transaction under §4.3c lock order (1 → 2 → 3).
 *
 * The filesystem link (Phase B) and activation (Phase C) are handled by
 * RES-1b's publication service. This module covers only the DB handoff.
 */

import type pkg from 'pg';
import { QuotaError } from '../../../../shared/config/quota.js';

export interface RegistryHandoffInput {
  reservationId: string;
  worldId: string;
  filename: string;
  url: string;
  mimetype: string;
  sizeBytes: number;
  contentSha256: string;
}

export interface HandoffDeps {
  withTransaction: <T>(fn: (tx: pkg.PoolClient) => Promise<T>) => Promise<T>;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
  metrics: {
    handoffTotal: { inc: (labels: { outcome: string }) => void };
  };
}

/** No-op metrics for tests. */
export function noopHandoffMetrics() {
  return {
    handoffTotal: { inc: (_labels: { outcome: string }) => {} },
  };
}

/**
 * Atomically transitions a reservation to COMMITTED and inserts the registry row.
 *
 * Lock sequence per ADR-017 §4.3c (file-mutating class):
 * 1. Level 1: pg_advisory_xact_lock(hashtext('media_global'))
 * 2. Level 2: pg_advisory_xact_lock(hashtext('media_quota:' || world_id))
 * 3. Position 3: world row FOR UPDATE
 * Then: reservation UPDATE + asset INSERT.
 *
 * The asset is inserted with publication_status='PENDING'. Reconciliation
 * does not alert on missing final files for PENDING rows.
 */
/**
 * Core handoff logic (takes an existing transaction).
 * B1: Single authoritative implementation. Both commitReservationToRegistry
 * (QUOTA-1) and phaseACommit (RES-1b) delegate here.
 *
 * Returns the assetId on success, or throws. Does NOT increment the
 * 'committed' metric — the caller does that after the transaction commits
 * (B4: metrics must not record uncommitted transactions).
 */
export async function doHandoffInTransaction(
  input: RegistryHandoffInput,
  deps: { log: HandoffDeps['log']; metrics: HandoffDeps['metrics'] },
  tx: pkg.PoolClient
): Promise<string> {
  // §4.3c lock order: 1 → 2 → 3.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [
    input.worldId,
  ]);
  await tx.query(`SELECT 1 FROM worlds WHERE world_id = $1 FOR UPDATE`, [input.worldId]);

  // Verify reservation exists, belongs to this world, and is committable.
  const res = await tx.query(
    `UPDATE storage_reservations
       SET state = 'COMMITTED', released_at = now()
     WHERE reservation_id = $1
       AND world_id = $2
       AND state IN ('RESERVED', 'WRITING')
     RETURNING reservation_id, world_id, size_bytes`,
    [input.reservationId, input.worldId]
  );

  if (res.rowCount === 0) {
    const check = await tx.query(
      `SELECT world_id, state FROM storage_reservations WHERE reservation_id = $1`,
      [input.reservationId]
    );
    if (check.rowCount === 0) {
      throw new QuotaError('RESERVATION_NOT_FOUND', 'Reservation does not exist.', 404);
    }
    if (check.rows[0].world_id !== input.worldId) {
      throw new QuotaError('WORLD_MISMATCH', 'Reservation belongs to a different world.', 403);
    }
    throw new QuotaError(
      'RESERVATION_NOT_ACTIVE',
      `Reservation is in state ${check.rows[0].state}, not committable.`,
      409
    );
  }

  if (Number(res.rows[0].size_bytes) !== input.sizeBytes) {
    throw new Error('Size mismatch between reservation and handoff input');
  }

  const asset = await tx.query(
    `INSERT INTO world_media_assets
       (world_id, filename, url, mimetype, size_bytes,
        lifecycle, file_confirmed_present, roles,
        publication_status, reservation_id, content_sha256)
     VALUES ($1, $2, $3, $4, $5, 'active', true, '{}',
             'PENDING', $6, $7)
     RETURNING asset_id`,
    [
      input.worldId,
      input.filename,
      input.url,
      input.mimetype,
      input.sizeBytes,
      input.reservationId,
      input.contentSha256,
    ]
  );

  const assetId = asset.rows[0].asset_id as string;
  deps.log('info', 'Reservation handed off to registry', {
    reservationId: input.reservationId,
    assetId,
    worldId: input.worldId,
    sizeBytes: input.sizeBytes,
  });

  return assetId;
}

/**
 * Handoff with transaction management and metrics.
 * B4: The 'committed' metric increments only after withTransaction resolves.
 */
export async function commitReservationToRegistry(
  input: RegistryHandoffInput,
  deps: HandoffDeps
): Promise<{ assetId: string }> {
  let assetId: string;
  try {
    assetId = await deps.withTransaction(async (tx) => {
      return doHandoffInTransaction(input, deps, tx);
    });
  } catch (err) {
    // B4: Record the failure outcome. 'committed' is never recorded here
    // because withTransaction threw (callback error or commit failure).
    const outcome =
      err instanceof QuotaError
        ? err.code === 'RESERVATION_NOT_FOUND'
          ? 'not_found'
          : err.code === 'WORLD_MISMATCH'
            ? 'world_mismatch'
            : 'not_active'
        : 'error';
    deps.metrics.handoffTotal.inc({ outcome });
    throw err;
  }
  // B4: 'committed' increments only after withTransaction resolves successfully.
  deps.metrics.handoffTotal.inc({ outcome: 'committed' });
  return { assetId };
}

/**
 * Calls the quota_used_bytes() SQL function.
 * Single definition per ADR-017 §5.1 — no inline reimplementation.
 */
export async function quotaUsedBytes(
  worldId: string,
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
): Promise<number> {
  const result = await query(`SELECT quota_used_bytes($1) AS total`, [worldId]);
  return Number(result.rows[0].total);
}
