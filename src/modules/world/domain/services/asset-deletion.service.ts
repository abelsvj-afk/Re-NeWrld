/**
 * DEL-1: Asset deletion state machine T1/T2 (ADR-017 §4.3b, design rev 3)
 *
 * Two-transaction deletion ensuring assets are only removed when no
 * active references exist, with crash recovery and idempotent retry.
 *
 * T1 (Decision): L1 → fence/backfill check → L2 → asset lock → scan → mark pending_deletion
 * T2 (Execution): L1 → L2 → asset lock → re-verify → unlink file → delete row
 */

import { stat, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type pkg from 'pg';
import { withTransaction } from '../../../../shared/database/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeletionErrorCode =
  | 'ASSET_NOT_FOUND'         // 404
  | 'ASSET_REFERENCED'        // 409 - active references exist
  | 'DELETION_ABORTED'        // 409 - lifecycle reverted, retry
  | 'FENCE_ACTIVE'            // 503
  | 'BACKFILL_IN_PROGRESS';   // 503

export class DeletionError extends Error {
  public readonly code: DeletionErrorCode;
  public readonly httpStatus: number;
  public readonly references?: Array<{ role: string }>;

  constructor(code: DeletionErrorCode, message: string, references?: Array<{ role: string }>) {
    super(message);
    this.name = 'DeletionError';
    this.code = code;
    this.httpStatus =
      code === 'ASSET_NOT_FOUND' ? 404 :
      code === 'FENCE_ACTIVE' || code === 'BACKFILL_IN_PROGRESS' ? 503 : 409;
    this.references = references;
  }
}

export interface DeletionDeps {
  /** Base directory for media storage (e.g., /data/media). */
  mediaRoot: string;
  /** Returns true if maintenance fence is active. */
  isFenceActive: (tx: pkg.PoolClient) => Promise<boolean>;
  /** Returns true if backfill is in progress. */
  isBackfillActive: (tx: pkg.PoolClient) => Promise<boolean>;
  /** Logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

export interface AssetInfo {
  assetId: string;
  worldId: string;
  url: string;
  lifecycle: string;
}

// ---------------------------------------------------------------------------
// T1: Decision Transaction
// ---------------------------------------------------------------------------

/**
 * T1: Decide whether deletion can proceed.
 *
 * Returns 'proceed' if asset was marked pending_deletion (or already was),
 * throws DeletionError for 404/409/503 cases.
 */
export async function deletionT1(
  assetId: string,
  worldId: string,
  deps: DeletionDeps
): Promise<'proceed'> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);

    // L1
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);

    // Fence and backfill checks (inside L1)
    if (await deps.isFenceActive(tx)) {
      throw new DeletionError('FENCE_ACTIVE', 'Maintenance fence is active');
    }
    if (await deps.isBackfillActive(tx)) {
      throw new DeletionError('BACKFILL_IN_PROGRESS', 'Backfill in progress');
    }

    // L2
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);

    // Asset row lock
    const assetResult = await tx.query(
      `SELECT asset_id, world_id, url, lifecycle FROM world_media_assets
       WHERE asset_id = $1 FOR UPDATE`,
      [assetId]
    );

    if (assetResult.rows.length === 0) {
      throw new DeletionError('ASSET_NOT_FOUND', `Asset not found: ${assetId}`);
    }

    const asset = assetResult.rows[0];
    if (asset.world_id !== worldId) {
      // Don't leak existence — return 404 for wrong world
      throw new DeletionError('ASSET_NOT_FOUND', `Asset not found: ${assetId}`);
    }

    // Idempotent: already pending_deletion → proceed to T2
    if (asset.lifecycle === 'pending_deletion') {
      deps.log('info', 'Asset already pending_deletion, proceeding to T2', { assetId });
      return 'proceed' as const;
    }

    if (asset.lifecycle !== 'active') {
      throw new DeletionError(
        'ASSET_NOT_FOUND',
        `Asset ${assetId} not in deletable state (lifecycle: ${asset.lifecycle})`
      );
    }

    // Authoritative reference scan (owning world only, pre-SHARE-1)
    const refs = await tx.query(
      `SELECT 'cover' AS role FROM worlds
       WHERE world_id = $2 AND metadata->>'coverArtUrl' = $1
       UNION
       SELECT 'illustration' AS role FROM scenes
       WHERE world_id = $2 AND metadata->>'illustrationUrl' = $1`,
      [asset.url, worldId]
    );

    if (refs.rows.length > 0) {
      throw new DeletionError(
        'ASSET_REFERENCED',
        `Asset ${assetId} has active references`,
        refs.rows.map((r) => ({ role: r.role }))
      );
    }

    // No references — mark pending_deletion
    await tx.query(
      `UPDATE world_media_assets SET lifecycle = 'pending_deletion' WHERE asset_id = $1`,
      [assetId]
    );

    deps.log('info', 'Asset marked pending_deletion', { assetId, worldId });
    return 'proceed' as const;
  });
}

// ---------------------------------------------------------------------------
// T2: Execution Transaction
// ---------------------------------------------------------------------------

/**
 * T2: Execute the deletion (unlink file, delete row).
 *
 * Returns 'deleted' on success. Throws DeletionError for abort cases.
 */
export async function deletionT2(
  assetId: string,
  worldId: string,
  deps: DeletionDeps
): Promise<'deleted'> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);

    // L1 → L2 → asset row (same order as T1)
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);

    const assetResult = await tx.query(
      `SELECT asset_id, world_id, url, lifecycle FROM world_media_assets
       WHERE asset_id = $1 FOR UPDATE`,
      [assetId]
    );

    // Row gone → idempotent success
    if (assetResult.rows.length === 0) {
      deps.log('info', 'Asset already deleted (row gone), idempotent success', { assetId });
      return 'deleted' as const;
    }

    const asset = assetResult.rows[0];

    // Lifecycle checks
    if (asset.lifecycle === 'active') {
      // Reverted by concurrent T2 step 4 or manual intervention
      throw new DeletionError(
        'DELETION_ABORTED',
        `Asset ${assetId} lifecycle reverted to active; retry DELETE`
      );
    }
    if (asset.lifecycle !== 'pending_deletion') {
      throw new Error(
        `Invariant violation: asset ${assetId} lifecycle is ${asset.lifecycle}, expected pending_deletion`
      );
    }

    // Re-run reference scan (defense in depth)
    const refs = await tx.query(
      `SELECT 'cover' AS role FROM worlds
       WHERE world_id = $2 AND metadata->>'coverArtUrl' = $1
       UNION
       SELECT 'illustration' AS role FROM scenes
       WHERE world_id = $2 AND metadata->>'illustrationUrl' = $1`,
      [asset.url, worldId]
    );

    if (refs.rows.length > 0) {
      // References appeared between T1 and T2 — revert to active
      await tx.query(
        `UPDATE world_media_assets SET lifecycle = 'active' WHERE asset_id = $1`,
        [assetId]
      );
      throw new DeletionError(
        'ASSET_REFERENCED',
        `Asset ${assetId} has active references (appeared after T1)`,
        refs.rows.map((r) => ({ role: r.role }))
      );
    }

    // Filesystem: derive path from URL, unlink
    const filename = asset.url.replace(/^\/media\//, '');
    const filePath = join(deps.mediaRoot, filename);

    try {
      await stat(filePath);
      // File exists — unlink it
      await unlink(filePath);
      deps.log('info', 'File unlinked', { assetId, filePath });

      // Fsync parent directory for durability
      const { open } = await import('node:fs/promises');
      const { constants } = await import('node:fs');
      const dirFd = await open(dirname(filePath), constants.O_RDONLY);
      try {
        await dirFd.sync();
      } finally {
        await dirFd.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File already gone (crash recovery) — proceed with row cleanup
        deps.log('warn', 'File already gone during deletion', { assetId, filePath });
      } else {
        throw err;
      }
    }

    // Mark file as gone (crash recovery signal) before row delete
    await tx.query(
      `UPDATE world_media_assets SET file_confirmed_present = false WHERE asset_id = $1`,
      [assetId]
    );

    // Delete the row
    await tx.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);

    deps.log('info', 'Asset deleted', { assetId, worldId });
    return 'deleted' as const;
  });
}

// ---------------------------------------------------------------------------
// Combined handler
// ---------------------------------------------------------------------------

/**
 * Full deletion flow: T1 then T2.
 * Throws DeletionError for all error cases.
 */
export async function deleteAsset(
  assetId: string,
  worldId: string,
  deps: DeletionDeps
): Promise<void> {
  await deletionT1(assetId, worldId, deps);
  await deletionT2(assetId, worldId, deps);
}
