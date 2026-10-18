/**
 * RES-1b Stale Temp Cleanup Worker (ADR-017 §1.6e)
 *
 * Cleans up temp files belonging to ACTIVE assets. Runs on startup (after
 * PENDING recovery) and periodically (every 15 minutes).
 *
 * Protocol (rev 14-30):
 * 1. Discovery: list .tmp/*.part, query for ACTIVE assets.
 * 2. Single-owner: processed Set per cycle; Pass 1 (files) + Pass 2 (DB markers).
 * 3. Write-ahead marker: SET pending=TRUE BEFORE unlink (never touches counters).
 * 4. Unlink with independent counter; fsync with independent counter.
 * 5. Alert lifecycle: incidents per (reservation_id, failure_type), outbox delivery.
 */

import { readdir, stat, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type pkg from 'pg';
import {
  acquireExclusiveNonBlocking,
  releaseLock,
  FlockError,
} from '../../../../shared/fs/flock.js';
import { lockPathFor } from './phase2-writer.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupDeps {
  mediaRoot: string;
  withTransaction: <T>(fn: (tx: pkg.PoolClient) => Promise<T>) => Promise<T>;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
  // Note: No notify dependency. The cleanup service creates durable outbox
  // events; the delivery worker (server.ts) claims and sends them.
  // This separates event creation (transactional with counters) from
  // delivery (external I/O with retry).
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Lists candidate temp files and queries for ACTIVE assets.
 * Returns reservation_ids with ACTIVE assets that have temp files.
 */
async function discoverCandidates(
  deps: CleanupDeps,
  tx: pkg.PoolClient,
): Promise<Array<{ reservationId: string; tempPath: string; assetId: string; finalPath: string }>> {
  const tmpDir = join(deps.mediaRoot, '.tmp');
  let files: string[];
  try {
    files = await readdir(tmpDir);
  } catch {
    return []; // No tmp dir.
  }

  const candidates = [];
  for (const file of files) {
    if (!file.endsWith('.part')) continue;
    const reservationId = basename(file, '.part');
    // Validate UUID format.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservationId)) {
      continue;
    }

    const result = await tx.query(
      `SELECT asset_id, filename FROM world_media_assets
       WHERE reservation_id=$1 AND publication_status='ACTIVE'`,
      [reservationId],
    );
    if (result.rowCount === 0) continue; // Not ACTIVE; skip (PENDING handled by §1.6a).

    candidates.push({
      reservationId,
      tempPath: join(tmpDir, file),
      assetId: result.rows[0].asset_id,
      finalPath: join(deps.mediaRoot, result.rows[0].filename),
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Cleanup protocol
// ---------------------------------------------------------------------------

/**
 * Runs one cleanup cycle.
 * Single-owner: processed Set ensures each reservation handled at most once.
 */
export async function runCleanupCycle(deps: CleanupDeps): Promise<void> {
  const processed = new Set<string>();

  await deps.withTransaction(async (tx) => {
    // Pass 1: file-listing discovery.
    const candidates = await discoverCandidates(deps, tx);
    for (const cand of candidates) {
      if (processed.has(cand.reservationId)) continue;
      await cleanupOne(cand, deps, tx);
      processed.add(cand.reservationId);
    }

    // Pass 2: DB pending markers (for cases where temp file is gone but fsync needed).
    const pending = await tx.query(
      `SELECT reservation_id, temp_cleanup_fsync_attempts, temp_cleanup_unlink_attempts
       FROM world_media_assets
       WHERE temp_cleanup_fsync_pending = TRUE AND publication_status = 'ACTIVE'`,
    );
    for (const row of pending.rows) {
      const reservationId: string = row.reservation_id;
      if (processed.has(reservationId)) continue; // Single-owner: skip if already handled.
      await retryPendingFsync(reservationId, deps, tx);
      processed.add(reservationId);
    }
  });
}

/**
 * Cleans up one temp file (write-ahead marker protocol).
 */
async function cleanupOne(
  cand: { reservationId: string; tempPath: string; assetId: string; finalPath: string },
  deps: CleanupDeps,
  tx: pkg.PoolClient,
): Promise<void> {
  const { reservationId, tempPath, finalPath } = cand;

  // B2: Acquire ownership lock BEFORE any filesystem observation or mutation.
  // If EWOULDBLOCK → another writer is active → skip this cycle.
  const lockPath = lockPathFor(deps.mediaRoot, reservationId);
  let ownershipLock;
  try {
    ownershipLock = await acquireExclusiveNonBlocking(lockPath);
  } catch (err) {
    if (err instanceof FlockError) {
      deps.log('info', 'Cleanup skipped: writer active', { reservationId });
      return; // Skip this cycle; retry next cycle.
    }
    throw err;
  }

  try {
    await cleanupOneLocked(cand, deps, tx);
  } finally {
    await releaseLock(ownershipLock);
  }
}

/**
 * Inner cleanup logic, executed while holding the ownership lock.
 */
async function cleanupOneLocked(
  cand: { reservationId: string; tempPath: string; assetId: string; finalPath: string },
  deps: CleanupDeps,
  tx: pkg.PoolClient,
): Promise<void> {
  const { reservationId, tempPath, finalPath } = cand;

  // Verification: stat temp and final, check inode identity.
  let tempStat, finalStat;
  try {
    tempStat = await stat(tempPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Already gone → reset unlink counter (ENOENT satisfies obligation, rev 18).
      await tx.query(
        `UPDATE world_media_assets SET temp_cleanup_unlink_attempts=0 WHERE reservation_id=$1`,
        [reservationId],
      );
      return;
    }
    throw err;
  }
  try {
    finalStat = await stat(finalPath);
  } catch {
    deps.log('error', 'ACTIVE asset missing file', { reservationId, finalPath });
    // Do NOT unlink temp; alert for manual investigation.
    return;
  }

  // Inode identity check.
  if (tempStat.ino !== finalStat.ino || tempStat.dev !== finalStat.dev) {
    deps.log('error', 'Temp inode mismatch', {
      reservationId,
      tempIno: tempStat.ino.toString(),
      finalIno: finalStat.ino.toString(),
    });
    return; // Do NOT unlink; operator must investigate.
  }

  // Write-ahead marker (rev 19: NEVER touches counters).
  await tx.query(
    `UPDATE world_media_assets
       SET temp_cleanup_fsync_pending = TRUE,
           temp_cleanup_last_attempt_at = now()
     WHERE reservation_id = $1 AND publication_status = 'ACTIVE'`,
    [reservationId],
  );

  // Unlink with independent counter.
  try {
    await unlink(tempPath);
    // Success → reset unlink counter.
    await tx.query(
      `UPDATE world_media_assets SET temp_cleanup_unlink_attempts=0 WHERE reservation_id=$1`,
      [reservationId],
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Already gone → reset (obligation satisfied).
      await tx.query(
        `UPDATE world_media_assets SET temp_cleanup_unlink_attempts=0 WHERE reservation_id=$1`,
        [reservationId],
      );
    } else {
      // Unlink failed → increment unlink counter.
      await tx.query(
        `UPDATE world_media_assets
           SET temp_cleanup_unlink_attempts = temp_cleanup_unlink_attempts + 1,
               temp_cleanup_last_attempt_at = now()
         WHERE reservation_id = $1`,
        [reservationId],
      );
      await checkAlertThreshold(reservationId, 'unlink', deps, tx);
      return; // Do NOT proceed to fsync.
    }
  }

  // Fsync temp dir.
  const tempDir = dirname(tempPath);
  try {
    const dirFd = await open(tempDir, constants.O_RDONLY);
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }
    // Success → clear marker, reset fsync counter. Do NOT touch unlink counter (rev 18).
    await tx.query(
      `UPDATE world_media_assets
         SET temp_cleanup_fsync_pending = FALSE,
             temp_cleanup_fsync_attempts = 0,
             temp_cleanup_last_attempt_at = now()
       WHERE reservation_id = $1`,
      [reservationId],
    );
    // Resolve fsync incident if open.
    await resolveIncident(reservationId, 'fsync', deps, tx);
  } catch (err) {
    // Fsync failed → increment fsync counter. Marker remains set.
    await tx.query(
      `UPDATE world_media_assets
         SET temp_cleanup_fsync_attempts = temp_cleanup_fsync_attempts + 1,
             temp_cleanup_last_attempt_at = now()
       WHERE reservation_id = $1`,
      [reservationId],
    );
    await checkAlertThreshold(reservationId, 'fsync', deps, tx);
    deps.log('warn', 'Fsync failed', { reservationId, error: (err as Error).message });
  }
}

/**
 * Retries pending fsync (Pass 2: temp file gone, but marker set).
 *
 * B6: Acquires the ownership lock before filesystem operations, like the
 * normal cleanup path. If a writer is active, skips this cycle.
 */
async function retryPendingFsync(
  reservationId: string,
  deps: CleanupDeps,
  tx: pkg.PoolClient,
): Promise<void> {
  const lockPath = lockPathFor(deps.mediaRoot, reservationId);
  let ownershipLock;
  try {
    ownershipLock = await acquireExclusiveNonBlocking(lockPath);
  } catch (err) {
    if (err instanceof FlockError) {
      deps.log('info', 'Pending fsync skipped: writer active', { reservationId });
      return;
    }
    throw err;
  }

  try {
    await retryPendingFsyncLocked(reservationId, deps, tx);
  } finally {
    await releaseLock(ownershipLock);
  }
}

/**
 * Inner pending-fsync logic, executed while holding the ownership lock.
 */
async function retryPendingFsyncLocked(
  reservationId: string,
  deps: CleanupDeps,
  tx: pkg.PoolClient,
): Promise<void> {
  // Find the asset to get the temp dir.
  const result = await tx.query(
    `SELECT reservation_id FROM world_media_assets
     WHERE reservation_id=$1 AND publication_status='ACTIVE'`,
    [reservationId],
  );
  if (result.rowCount === 0) return;

  // Temp is absent (Pass 2 only runs when file listing found nothing).
  // Reset unlink counter (ENOENT rule, rev 19 consistency).
  await tx.query(
    `UPDATE world_media_assets SET temp_cleanup_unlink_attempts=0 WHERE reservation_id=$1`,
    [reservationId],
  );

  // Fsync the temp dir.
  const tmpDir = join(deps.mediaRoot, '.tmp');
  try {
    const dirFd = await open(tmpDir, constants.O_RDONLY);
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }
    // Success → clear marker, reset fsync counter.
    await tx.query(
      `UPDATE world_media_assets
         SET temp_cleanup_fsync_pending = FALSE,
             temp_cleanup_fsync_attempts = 0
       WHERE reservation_id = $1`,
      [reservationId],
    );
    await resolveIncident(reservationId, 'fsync', deps, tx);
  } catch {
    await tx.query(
      `UPDATE world_media_assets
         SET temp_cleanup_fsync_attempts = temp_cleanup_fsync_attempts + 1,
             temp_cleanup_last_attempt_at = now()
       WHERE reservation_id = $1`,
      [reservationId],
    );
    await checkAlertThreshold(reservationId, 'fsync', deps, tx);
  }
}

// ---------------------------------------------------------------------------
// Alert lifecycle
// ---------------------------------------------------------------------------

/**
 * Checks if a counter reached a firing threshold (5, 10, 15, ...).
 * Creates/updates incident and outbox event.
 *
 * Exported for testing (B4: tests must exercise real service behavior).
 */
export async function checkAlertThreshold(
  reservationId: string,
  failureType: 'unlink' | 'fsync',
  deps: CleanupDeps,
  tx: pkg.PoolClient,
): Promise<void> {
  const counterCol = failureType === 'unlink'
    ? 'temp_cleanup_unlink_attempts'
    : 'temp_cleanup_fsync_attempts';

  const result = await tx.query(
    `SELECT ${counterCol} as count FROM world_media_assets WHERE reservation_id=$1`,
    [reservationId],
  );
  const count: number = result.rows[0].count;

  // Fire at 5, 10, 15, ...
  if (count % 5 !== 0) return;

  const severity = count >= 15 ? 'critical' : 'warning';

  // Find or create incident.
  let incidentId: string;
  const existing = await tx.query(
    `SELECT incident_id, status FROM temp_cleanup_incidents
     WHERE reservation_id=$1 AND failure_type=$2 AND status IN ('open','escalated')`,
    [reservationId, failureType],
  );

  if (existing.rowCount === 0) {
    // New incident.
    const ins = await tx.query(
      `INSERT INTO temp_cleanup_incidents
         (reservation_id, failure_type, status, last_fired_count)
       VALUES ($1, $2, $3, $4)
       RETURNING incident_id`,
      [reservationId, failureType, count >= 15 ? 'escalated' : 'open', count],
    );
    incidentId = ins.rows[0].incident_id;
    if (count >= 15) {
      await tx.query(
        `UPDATE temp_cleanup_incidents SET escalated_at=now() WHERE incident_id=$1`,
        [incidentId],
      );
    }
  } else {
    incidentId = existing.rows[0].incident_id;
    const newStatus = count >= 15 ? 'escalated' : 'open';
    await tx.query(
      `UPDATE temp_cleanup_incidents
         SET last_fired_at=now(), last_fired_count=$1, status=$2
             ${count >= 15 ? `, escalated_at=COALESCE(escalated_at, now())` : ''}
       WHERE incident_id=$3 AND status IN ('open','escalated')`,
      [count, newStatus, incidentId],
    );
  }

  // Create outbox event.
  const eventResult = await tx.query(
    `INSERT INTO temp_cleanup_delivery_outbox
       (incident_id, reservation_id, failure_type, fire_count, severity, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (incident_id, fire_count) DO NOTHING
     RETURNING delivery_event_id`,
    [incidentId, reservationId, failureType, count, severity],
  );

  if (eventResult.rowCount === 0) return; // Already exists.

  const deliveryEventId: string = eventResult.rows[0].delivery_event_id;
  deps.log(count >= 15 ? 'error' : 'warn', 'Alert fired', {
    reservationId,
    failureType,
    count,
    severity,
    incidentId,
  });

  // Event is durably in the outbox. The delivery worker (server.ts)
  // will claim it via FOR UPDATE SKIP LOCKED and send it.
}

/**
 * Resolves an incident when the operation succeeds.
 *
 * Exported for testing.
 */
export async function resolveIncident(
  reservationId: string,
  failureType: 'unlink' | 'fsync',
  deps: CleanupDeps,
  tx: pkg.PoolClient,
): Promise<void> {
  await tx.query(
    `UPDATE temp_cleanup_incidents
       SET status='resolved', resolved_at=now()
     WHERE reservation_id=$1 AND failure_type=$2 AND status IN ('open','escalated')`,
    [reservationId, failureType],
  );
  deps.log('info', 'Incident resolved', { reservationId, failureType });
}
