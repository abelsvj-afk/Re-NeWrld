/**
 * RES-1b Crash-Safe Publication Protocol (ADR-017 §1.6)
 *
 * Implements the three-phase publication:
 *   Phase A — Database commit (transactional): INSERT asset PENDING + reservation COMMITTED.
 *   Phase B — Filesystem publication (non-transactional): link → fsync(final) → unlink → fsync(temp).
 *   Phase C — Mark ACTIVE (transactional).
 *
 * Uses link() (not rename) to never overwrite. EEXIST triggers identity verification
 * via inode equality or content digest (SHA-256).
 */

import { link, unlink, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import type pkg from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublicationErrorCode =
  | 'PUBLICATION_COLLISION'      // Destination exists, different bytes, ACTIVE asset
  | 'PUBLICATION_IDENTITY_UNVERIFIED' // EEXIST, cannot prove identity
  | 'PUBLICATION_FAILED'         // Link failed, temp gone, no recovery
  | 'RESERVATION_NOT_COMMITTABLE'; // Reservation not in committable state

export class PublicationError extends Error {
  public readonly code: PublicationErrorCode;
  constructor(code: PublicationErrorCode, message: string) {
    super(message);
    this.name = 'PublicationError';
    this.code = code;
  }
}

export interface PublicationDeps {
  /** Executes a function within a DB transaction. */
  withTransaction: <T>(fn: (tx: pkg.PoolClient) => Promise<T>) => Promise<T>;
  /** Logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

export interface PublicationInput {
  reservationId: string;
  worldId: string;
  tempPath: string;
  finalFilename: string; // e.g., {uuid}.{ext}
  mediaRoot: string;     // e.g., /data/media
  mimetype: string;
  sizeBytes: number;
  contentSha256: string; // hex digest computed during writes
}

// ---------------------------------------------------------------------------
// Phase A — Database commit
// ---------------------------------------------------------------------------

/**
 * Phase A: INSERT asset (PENDING) + transition reservation to COMMITTED, atomically.
 *
 * Per design §1.6:
 * 1. fsync temp file and directory (caller ensures before calling).
 * 2. BEGIN; acquire L1 → L2 → L3 (via RES-1a lock ordering; caller holds file LOCK_SH).
 * 3. INSERT world_media_assets (publication_status='PENDING', content_sha256).
 * 4. UPDATE storage_reservations SET state='COMMITTED', released_at=now()
 *    WHERE reservation_id=? AND released_at IS NULL AND state IN ('RESERVED','WRITING').
 * 5. Verify exactly 1 row; if 0 → ROLLBACK (asset INSERT rolled back too).
 * 6. COMMIT.
 *
 * Returns the asset_id.
 */
export async function phaseACommit(
  input: PublicationInput,
  deps: PublicationDeps,
  tx: pkg.PoolClient,
): Promise<string> {
  // INSERT asset as PENDING.
  const assetResult = await tx.query(
    `INSERT INTO world_media_assets
       (world_id, filename, url, mimetype, size_bytes, roles, publication_status, content_sha256, reservation_id)
     VALUES ($1, $2, $3, $4, $5, '{}', 'PENDING', $6, $7)
     RETURNING asset_id`,
    [
      input.worldId,
      input.finalFilename,
      `/media/${input.finalFilename}`,
      input.mimetype,
      input.sizeBytes,
      input.contentSha256,
      input.reservationId,
    ],
  );
  const assetId: string = assetResult.rows[0].asset_id;

  // Transition reservation to COMMITTED.
  const resResult = await tx.query(
    `UPDATE storage_reservations
       SET state='COMMITTED', released_at=now()
     WHERE reservation_id=$1 AND released_at IS NULL AND state IN ('RESERVED','WRITING')`,
    [input.reservationId],
  );

  if (resResult.rowCount !== 1) {
    throw new PublicationError(
      'RESERVATION_NOT_COMMITTABLE',
      `Reservation ${input.reservationId} not in committable state; Phase A aborted`,
    );
  }

  deps.log('info', 'Phase A committed', {
    reservationId: input.reservationId,
    assetId,
  });

  return assetId;
}

// ---------------------------------------------------------------------------
// Phase B — Filesystem publication
// ---------------------------------------------------------------------------

/**
 * Phase B: link → fsync(final_dir) → unlink → fsync(temp_dir).
 *
 * Uses link() (not rename) to never overwrite. Handles EEXIST via identity
 * verification (inode equality or digest match).
 *
 * Returns 'published' if the file is now at final_path (link durable),
 * or throws PublicationError.
 */
export async function phaseBPublish(
  input: PublicationInput,
  assetId: string,
  deps: PublicationDeps,
  tx: pkg.PoolClient, // for reading asset row on EEXIST
): Promise<'published'> {
  const finalPath = join(input.mediaRoot, input.finalFilename);
  const tempDir = dirname(input.tempPath);
  const finalDir = dirname(finalPath);

  // Step 8: link(temp, final)
  try {
    await link(input.tempPath, finalPath);
    deps.log('info', 'Link succeeded', { temp: input.tempPath, final: finalPath });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Destination exists → verify identity.
      await verifyEexist(input, assetId, deps, tx);
    } else if (code === 'ENOENT') {
      // Temp gone → check if final exists (crash recovery).
      try {
        await stat(finalPath);
        // Final exists → treat as EEXIST case.
        await verifyEexist(input, assetId, deps, tx);
      } catch {
        // Neither exists → fail.
        await markPublicationFailed(assetId, tx, deps);
        throw new PublicationError(
          'PUBLICATION_FAILED',
          `Temp gone and final missing for ${input.reservationId}`,
        );
      }
    } else {
      throw err;
    }
  }

  // Step 8b: fsync(final_dir) — MUST complete before unlink.
  // We fsync by opening the directory and calling fsync.
  const { open } = await import('node:fs/promises');
  const finalDirFd = await open(finalDir, constants.O_RDONLY);
  try {
    await finalDirFd.sync();
  } finally {
    await finalDirFd.close();
  }

  // Step 8c: unlink(temp)
  try {
    await unlink(input.tempPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // ENOENT → already unlinked, idempotent. Proceed.
  }

  // Step 8d: fsync(temp_dir) — always, even if same as final_dir.
  const tempDirFd = await open(tempDir, constants.O_RDONLY);
  try {
    await tempDirFd.sync();
  } finally {
    await tempDirFd.close();
  }

  return 'published';
}

/**
 * EEXIST verification (§1.6, step 8a).
 * Proves identity via inode equality or content digest. Fail closed.
 */
async function verifyEexist(
  input: PublicationInput,
  assetId: string,
  deps: PublicationDeps,
  tx: pkg.PoolClient,
): Promise<void> {
  const finalPath = join(input.mediaRoot, input.finalFilename);

  let finalStat, tempStat;
  try {
    finalStat = await stat(finalPath);
  } catch {
    throw new PublicationError('PUBLICATION_FAILED', `Final path stat failed: ${finalPath}`);
  }
  try {
    tempStat = await stat(input.tempPath);
  } catch {
    tempStat = null; // Temp may be gone.
  }

  // Inode equality → idempotent retry.
  if (tempStat && finalStat.ino === tempStat.ino && finalStat.dev === tempStat.dev) {
    deps.log('info', 'EEXIST: inode equality proves idempotent retry', {
      reservationId: input.reservationId,
    });
    return;
  }

  // Check for ACTIVE asset collision.
  const collision = await tx.query(
    `SELECT asset_id, reservation_id FROM world_media_assets
     WHERE filename=$1 AND publication_status='ACTIVE' AND asset_id != $2`,
    [input.finalFilename, assetId],
  );
  if (collision.rowCount && collision.rowCount > 0) {
    await markPublicationFailed(assetId, tx, deps);
    throw new PublicationError(
      'PUBLICATION_COLLISION',
      `Destination ${input.finalFilename} already published by ${collision.rows[0].reservation_id}`,
    );
  }

  // Digest verification.
  const assetRow = await tx.query(
    `SELECT content_sha256 FROM world_media_assets WHERE asset_id=$1`,
    [assetId],
  );
  const recordedDigest: string | null = assetRow.rows[0]?.content_sha256;
  if (!recordedDigest) {
    await markIdentityUnverified(assetId, tx, deps);
    throw new PublicationError(
      'PUBLICATION_IDENTITY_UNVERIFIED',
      `No digest recorded for ${assetId}; cannot verify EEXIST destination`,
    );
  }

  // Compute digest of final_path.
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const finalBytes = await readFile(finalPath);
  const finalDigest = createHash('sha256').update(finalBytes).digest('hex');

  if (finalDigest === recordedDigest) {
    deps.log('info', 'EEXIST: digest match proves identity', {
      reservationId: input.reservationId,
    });
    return;
  }

  // Digests differ → fail closed.
  await markIdentityUnverified(assetId, tx, deps);
  throw new PublicationError(
    'PUBLICATION_IDENTITY_UNVERIFIED',
    `Digest mismatch for ${input.finalFilename}; fail closed`,
  );
}

async function markPublicationFailed(
  assetId: string,
  tx: pkg.PoolClient,
  deps: PublicationDeps,
): Promise<void> {
  await tx.query(
    `UPDATE world_media_assets SET publication_status='PUBLICATION_FAILED' WHERE asset_id=$1`,
    [assetId],
  );
  deps.log('error', 'Marked PUBLICATION_FAILED', { assetId });
}

async function markIdentityUnverified(
  assetId: string,
  tx: pkg.PoolClient,
  deps: PublicationDeps,
): Promise<void> {
  await tx.query(
    `UPDATE world_media_assets SET publication_status='PUBLICATION_IDENTITY_UNVERIFIED' WHERE asset_id=$1`,
    [assetId],
  );
  deps.log('error', 'Marked PUBLICATION_IDENTITY_UNVERIFIED', { assetId });
}

// ---------------------------------------------------------------------------
// Phase C — Mark ACTIVE
// ---------------------------------------------------------------------------

/**
 * Phase C: Mark asset ACTIVE after Phase B completes.
 */
export async function phaseCMarkActive(
  assetId: string,
  tx: pkg.PoolClient,
  deps: PublicationDeps,
): Promise<void> {
  await tx.query(
    `UPDATE world_media_assets SET publication_status='ACTIVE', updated_at=now() WHERE asset_id=$1`,
    [assetId],
  );
  deps.log('info', 'Phase C: marked ACTIVE', { assetId });
}
