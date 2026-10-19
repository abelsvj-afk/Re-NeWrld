/**
 * DEL-2: World deletion state machine T1–T5 (ADR-017 §4.9, design rev 2)
 *
 * Draft-only world deletion with crash recovery via job table.
 * Published worlds are blocked (409 WORLD_HAS_PUBLISHED_VERSIONS).
 */

import { stat, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pkg from 'pg';
import { withTransaction } from '../../../../shared/database/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorldDeletionErrorCode =
  | 'WORLD_NOT_FOUND'           // 404
  | 'WORLD_HAS_PUBLISHED_VERSIONS' // 409
  | 'DELETION_IN_PROGRESS'      // 409
  | 'FENCE_ACTIVE'              // 503
  | 'BACKFILL_IN_PROGRESS';     // 503

export class WorldDeletionError extends Error {
  public readonly code: WorldDeletionErrorCode;
  public readonly httpStatus: number;

  constructor(code: WorldDeletionErrorCode, message: string) {
    super(message);
    this.name = 'WorldDeletionError';
    this.code = code;
    this.httpStatus =
      code === 'WORLD_NOT_FOUND' ? 404 :
      code === 'FENCE_ACTIVE' || code === 'BACKFILL_IN_PROGRESS' ? 503 : 409;
  }
}

export interface WorldDeletionDeps {
  mediaRoot: string;
  isFenceActive: (tx: pkg.PoolClient) => Promise<boolean>;
  isBackfillActive: (tx: pkg.PoolClient) => Promise<boolean>;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

type JobState = 't1_complete' | 't2_complete' | 't3_complete' | 't4_complete' | 'complete' | 'failed';

// ---------------------------------------------------------------------------
// T1: Preparation
// ---------------------------------------------------------------------------

export async function worldDeletionT1(
  worldId: string,
  deps: WorldDeletionDeps
): Promise<string> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);

    if (await deps.isFenceActive(tx)) {
      throw new WorldDeletionError('FENCE_ACTIVE', 'Maintenance fence is active');
    }
    if (await deps.isBackfillActive(tx)) {
      throw new WorldDeletionError('BACKFILL_IN_PROGRESS', 'Backfill in progress');
    }

    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);

    // Check for existing job
    const jobCheck = await tx.query(
      `SELECT job_id, state FROM world_deletion_jobs WHERE world_id = $1 AND state != 'complete'`,
      [worldId]
    );
    if (jobCheck.rows.length > 0) {
      const job = jobCheck.rows[0];
      if (job.state === 'failed') {
        throw new WorldDeletionError('DELETION_IN_PROGRESS', `Deletion job ${job.job_id} failed; operator intervention required`);
      }
      // Resume existing job
      deps.log('info', 'Resuming existing deletion job', { jobId: job.job_id, state: job.state });
      return job.job_id as string;
    }

    // Lock world row
    const worldResult = await tx.query(
      `SELECT world_id FROM worlds WHERE world_id = $1 FOR UPDATE`,
      [worldId]
    );
    if (worldResult.rows.length === 0) {
      throw new WorldDeletionError('WORLD_NOT_FOUND', `World not found: ${worldId}`);
    }

    // Check for published snapshots
    const pubCheck = await tx.query(
      `SELECT snapshot_id FROM canon_snapshots WHERE world_id = $1 LIMIT 1`,
      [worldId]
    );
    if (pubCheck.rows.length > 0) {
      throw new WorldDeletionError(
        'WORLD_HAS_PUBLISHED_VERSIONS',
        'Cannot delete world with published versions'
      );
    }

    const jobId = randomUUID();

    // T1a: Transfer shared assets to first borrower
    const sharedAssets = await tx.query(
      `SELECT asset_id, shared_with_worlds FROM world_media_assets
       WHERE world_id = $1 AND array_length(shared_with_worlds, 1) > 0`,
      [worldId]
    );
    for (const asset of sharedAssets.rows) {
      const borrowers: string[] = asset.shared_with_worlds;
      const newOwner = borrowers[0];
      const remaining = borrowers.slice(1);
      await tx.query(
        `UPDATE world_media_assets
         SET world_id = $2, shared_with_worlds = $3
         WHERE asset_id = $1`,
        [asset.asset_id, newOwner, remaining]
      );
      deps.log('info', 'Transferred shared asset', {
        assetId: asset.asset_id, from: worldId, to: newOwner,
      });
    }

    // T1b: Transfer snapshot-protected assets to unattributed (world_id = NULL)
    const protectedAssets = await tx.query(
      `SELECT DISTINCT a.asset_id FROM world_media_assets a
       JOIN asset_snapshot_references r ON r.asset_id = a.asset_id
       WHERE a.world_id = $1`,
      [worldId]
    );
    for (const asset of protectedAssets.rows) {
      await tx.query(
        `UPDATE world_media_assets SET world_id = NULL WHERE asset_id = $1`,
        [asset.asset_id]
      );
      deps.log('info', 'Transferred snapshot-protected asset to unattributed', {
        assetId: asset.asset_id,
      });
    }

    // Create job row
    await tx.query(
      `INSERT INTO world_deletion_jobs (job_id, world_id, state) VALUES ($1, $2, 't1_complete')`,
      [jobId, worldId]
    );

    deps.log('info', 'World deletion T1 complete', { jobId, worldId });
    return jobId;
  });
}

// ---------------------------------------------------------------------------
// T2: Mark deletion
// ---------------------------------------------------------------------------

export async function worldDeletionT2(
  jobId: string,
  worldId: string,
  deps: WorldDeletionDeps
): Promise<void> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);

    // Verify job state
    const jobResult = await tx.query(
      `SELECT state FROM world_deletion_jobs WHERE job_id = $1 FOR UPDATE`,
      [jobId]
    );
    if (jobResult.rows.length === 0 || jobResult.rows[0].state !== 't1_complete') {
      throw new Error(`Invalid job state for T2: ${jobId}`);
    }

    // Lock world row
    await tx.query(`SELECT world_id FROM worlds WHERE world_id = $1 FOR UPDATE`, [worldId]);

    // Mark all owned assets as pending_deletion (sorted for deadlock prevention)
    const assets = await tx.query(
      `SELECT asset_id FROM world_media_assets WHERE world_id = $1 ORDER BY asset_id FOR UPDATE`,
      [worldId]
    );
    for (const asset of assets.rows) {
      await tx.query(
        `UPDATE world_media_assets SET lifecycle = 'pending_deletion' WHERE asset_id = $1`,
        [asset.asset_id]
      );
    }

    // Clean up referencing_worlds: remove this world from others' shared arrays
    await tx.query(
      `UPDATE world_media_assets
       SET shared_with_worlds = array_remove(shared_with_worlds, $1)
       WHERE $1 = ANY(shared_with_worlds)`,
      [worldId]
    );

    await tx.query(
      `UPDATE world_deletion_jobs SET state = 't2_complete', updated_at = now() WHERE job_id = $1`,
      [jobId]
    );

    deps.log('info', 'World deletion T2 complete', { jobId, worldId, assetsMarked: assets.rows.length });
  });
}

// ---------------------------------------------------------------------------
// T3: File deletion
// ---------------------------------------------------------------------------

export async function worldDeletionT3(
  jobId: string,
  worldId: string,
  deps: WorldDeletionDeps
): Promise<void> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);

    const jobResult = await tx.query(
      `SELECT state FROM world_deletion_jobs WHERE job_id = $1`,
      [jobId]
    );
    if (jobResult.rows.length === 0 || jobResult.rows[0].state !== 't2_complete') {
      throw new Error(`Invalid job state for T3: ${jobId}`);
    }

    // Get pending_deletion assets (no row locks — filesystem operation)
    const assets = await tx.query(
      `SELECT asset_id, url FROM world_media_assets
       WHERE world_id = $1 AND lifecycle = 'pending_deletion'`,
      [worldId]
    );

    for (const asset of assets.rows) {
      const filename = (asset.url as string).replace(/^\/media\//, '');
      const filePath = join(deps.mediaRoot, filename);
      try {
        await stat(filePath);
        await unlink(filePath);
        const { open } = await import('node:fs/promises');
        const { constants } = await import('node:fs');
        const dirFd = await open(dirname(filePath), constants.O_RDONLY);
        try { await dirFd.sync(); } finally { await dirFd.close(); }
        deps.log('info', 'Deleted asset file', { assetId: asset.asset_id });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          deps.log('warn', 'File already gone', { assetId: asset.asset_id });
        } else {
          throw err;
        }
      }
    }

    await tx.query(
      `UPDATE world_deletion_jobs SET state = 't3_complete', updated_at = now() WHERE job_id = $1`,
      [jobId]
    );

    deps.log('info', 'World deletion T3 complete', { jobId, worldId, filesDeleted: assets.rows.length });
  });
}

// ---------------------------------------------------------------------------
// T4: Row cleanup
// ---------------------------------------------------------------------------

export async function worldDeletionT4(
  jobId: string,
  worldId: string,
  deps: WorldDeletionDeps
): Promise<void> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);

    const jobResult = await tx.query(
      `SELECT state FROM world_deletion_jobs WHERE job_id = $1 FOR UPDATE`,
      [jobId]
    );
    if (jobResult.rows.length === 0 || jobResult.rows[0].state !== 't3_complete') {
      throw new Error(`Invalid job state for T4: ${jobId}`);
    }

    // Delete asset rows (sorted)
    const assets = await tx.query(
      `SELECT asset_id FROM world_media_assets
       WHERE world_id = $1 AND lifecycle = 'pending_deletion'
       ORDER BY asset_id FOR UPDATE`,
      [worldId]
    );
    for (const asset of assets.rows) {
      await tx.query(`DELETE FROM asset_snapshot_references WHERE asset_id = $1`, [asset.asset_id]);
      await tx.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [asset.asset_id]);
    }

    await tx.query(
      `UPDATE world_deletion_jobs SET state = 't4_complete', updated_at = now() WHERE job_id = $1`,
      [jobId]
    );

    deps.log('info', 'World deletion T4 complete', { jobId, worldId, rowsDeleted: assets.rows.length });
  });
}

// ---------------------------------------------------------------------------
// T5: World deletion
// ---------------------------------------------------------------------------

export async function worldDeletionT5(
  jobId: string,
  worldId: string,
  deps: WorldDeletionDeps
): Promise<void> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);

    const jobResult = await tx.query(
      `SELECT state FROM world_deletion_jobs WHERE job_id = $1 FOR UPDATE`,
      [jobId]
    );
    if (jobResult.rows.length === 0 || jobResult.rows[0].state !== 't4_complete') {
      throw new Error(`Invalid job state for T5: ${jobId}`);
    }

    // Delete world row (cascades to scenes, choices, etc.)
    await tx.query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);

    await tx.query(
      `UPDATE world_deletion_jobs SET state = 'complete', updated_at = now() WHERE job_id = $1`,
      [jobId]
    );

    deps.log('info', 'World deletion T5 complete', { jobId, worldId });
  });
}

// ---------------------------------------------------------------------------
// Combined handler
// ---------------------------------------------------------------------------

export async function deleteWorld(
  worldId: string,
  deps: WorldDeletionDeps
): Promise<void> {
  const jobId = await worldDeletionT1(worldId, deps);
  await worldDeletionT2(jobId, worldId, deps);
  await worldDeletionT3(jobId, worldId, deps);
  await worldDeletionT4(jobId, worldId, deps);
  await worldDeletionT5(jobId, worldId, deps);
}
