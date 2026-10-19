/**
 * UPLOAD-1: Staging allowance lifecycle (ADR-017 §4.4, design rev 24)
 *
 * A staging allowance reserves quota BEFORE any file bytes are accepted.
 * This closes the accounting gap where streaming before reservation allowed
 * unaccounted disk usage.
 *
 * Flow:
 *   1. createAllowance() — DB txn (L1 held), quota checked including allowances
 *   2. Stream bytes to /data/media/.staging/{allowance_id}.tmp (caller holds LOCK_EX)
 *   3. convertAllowance() — DB txn (L1 held), allowance → reservation, .part created
 *   4. Transfer bytes staging → .part (inode preserved)
 *   5. Set bytes_ready=true
 *
 * States: 'active' → 'expiring' → 'expired' (cleanup)
 *         'active'/'expiring' → 'cancelled' (conversion)
 */

import { open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import type pkg from 'pg';
import { withTransaction } from '../../../../shared/database/db.js';
import { acquireExclusiveNonBlocking, releaseLock, type LockHandle } from '../../../../shared/fs/flock.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AllowanceErrorCode =
  | 'FENCE_ACTIVE'
  | 'BACKFILL_IN_PROGRESS'
  | 'QUOTA_EXCEEDED'
  | 'STAGING_EXPIRED'
  | 'STAGING_FILE_MISSING'
  | 'ALLOWANCE_NOT_FOUND'
  | 'STORAGE_WRITE_FAILED'; // API-1 §9.3: filesystem I/O error

export class StagingAllowanceError extends Error {
  public readonly code: AllowanceErrorCode;
  public readonly httpStatus: number;

  constructor(code: AllowanceErrorCode, message: string) {
    super(message);
    this.name = 'StagingAllowanceError';
    this.code = code;
    this.httpStatus =
      code === 'QUOTA_EXCEEDED' ? 507 :
      code === 'FENCE_ACTIVE' || code === 'BACKFILL_IN_PROGRESS' ? 503 :
      code === 'STAGING_EXPIRED' || code === 'STAGING_FILE_MISSING' ? 500 : 500;
  }
}

export interface StagingAllowance {
  allowanceId: string;
  worldId: string;
  maxBytes: number;
  state: string;
  expiresAt: Date;
}

export interface StagingDeps {
  /** Per-world quota in bytes. */
  quotaBytes: number;
  /** Max staging bytes per allowance (10 MB). */
  maxStagingBytes: number;
  /** Allowance TTL in ms (2 minutes). */
  allowanceTtlMs: number;
  /** Base directory for media storage (e.g., /data/media). */
  mediaRoot: string;
  /** Returns true if maintenance fence is active. */
  isFenceActive: (tx: pkg.PoolClient) => Promise<boolean>;
  /** Returns true if backfill is in progress. */
  isBackfillActive: (tx: pkg.PoolClient) => Promise<boolean>;
  /** Single quota definition (counts allowances). */
  quotaUsedBytes: (worldId: string, tx: pkg.PoolClient) => Promise<number>;
  /** Locks world row FOR UPDATE; throws if not found. */
  lockWorldRow: (worldId: string, tx: pkg.PoolClient) => Promise<void>;
  /** Creates a storage reservation (repository). */
  createReservation: (
    worldId: string,
    sizeBytes: number,
    bytesReady: boolean,
    tx: pkg.PoolClient
  ) => Promise<{ reservationId: string }>;
  /** Logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Staging file path: {mediaRoot}/.staging/{allowance_id}.tmp */
export function stagingPathFor(mediaRoot: string, allowanceId: string): string {
  return join(mediaRoot, '.staging', `${allowanceId}.tmp`);
}

/** Temp .part path: {mediaRoot}/.tmp/{reservation_id}.part */
export function partPathFor(mediaRoot: string, reservationId: string): string {
  return join(mediaRoot, '.tmp', `${reservationId}.part`);
}

// ---------------------------------------------------------------------------
// Allowance creation
// ---------------------------------------------------------------------------

/**
 * Creates a staging allowance BEFORE any file bytes are accepted.
 *
 * Transaction (L1 → L2 → world row):
 * 1. Acquire L1 (serializes vs fence, backfill, other uploads)
 * 2. Check fence → 503 FENCE_ACTIVE
 * 3. Check backfill → 503 BACKFILL_IN_PROGRESS
 * 4. Check quota (including existing allowances) → 507 QUOTA_EXCEEDED
 * 5. INSERT allowance row
 * 6. COMMIT
 */
export async function createAllowance(
  worldId: string,
  deps: StagingDeps
): Promise<StagingAllowance> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);
    await deps.lockWorldRow(worldId, tx);

    if (await deps.isFenceActive(tx)) {
      throw new StagingAllowanceError('FENCE_ACTIVE', 'Maintenance fence is active');
    }
    if (await deps.isBackfillActive(tx)) {
      throw new StagingAllowanceError('BACKFILL_IN_PROGRESS', 'Backfill is in progress');
    }

    const used = await deps.quotaUsedBytes(worldId, tx);
    if (used + deps.maxStagingBytes > deps.quotaBytes) {
      throw new StagingAllowanceError(
        'QUOTA_EXCEEDED',
        `World quota exceeded: ${used + deps.maxStagingBytes} > ${deps.quotaBytes}`
      );
    }

    const result = await tx.query(
      `INSERT INTO staging_allowances (world_id, max_bytes, state, expires_at)
       VALUES ($1, $2, 'active', clock_timestamp() + make_interval(secs => $3))
       RETURNING allowance_id, world_id, max_bytes, state, expires_at`,
      [worldId, deps.maxStagingBytes, deps.allowanceTtlMs / 1000]
    );

    const row = result.rows[0];
    deps.log('info', 'Staging allowance created', {
      allowanceId: row.allowance_id,
      worldId,
      maxBytes: deps.maxStagingBytes,
    });

    return {
      allowanceId: row.allowance_id,
      worldId: row.world_id,
      maxBytes: Number(row.max_bytes),
      state: row.state,
      expiresAt: row.expires_at,
    };
  });
}

/**
 * Acquires an exclusive lock on the staging file.
 * The caller holds this during streaming. Cleanup uses LOCK_NB and skips if held.
 */
export async function lockStagingFile(
  mediaRoot: string,
  allowanceId: string
): Promise<{ handle: LockHandle; fd: FileHandle }> {
  const path = stagingPathFor(mediaRoot, allowanceId);
  await open(dirname(path), constants.O_RDONLY).then(async (dirFd) => {
    // Ensure .staging directory exists
    await dirFd.close();
  }).catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(path), { recursive: true });
  });

  const fd = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_TRUNC, 0o644);
  const handle = await acquireExclusiveNonBlocking(path);
  return { handle, fd };
}

// ---------------------------------------------------------------------------
// Allowance → Reservation conversion
// ---------------------------------------------------------------------------

export interface ConvertResult {
  reservationId: string;
  sizeBytes: number;
}

/**
 * Atomically converts a staging allowance to a storage reservation.
 *
 * Protocol (design rev 24):
 * 1. Caller must hold LOCK_EX on staging file (acquired via lockStagingFile).
 * 2. BEGIN; L1 → L2 → world row → claim allowance (UPDATE to 'cancelled').
 * 3. Re-check fence/backfill.
 * 4. Create reservation (bytes_ready=false).
 * 5. Create empty .part file (before COMMIT, rev 11).
 * 6. COMMIT.
 * 7. Transfer bytes staging → .part (inode preserved, rev 12).
 * 8. Set bytes_ready=true (no L1, bounded lock_timeout).
 * 9. Unlink staging file, release locks.
 */
export async function convertAllowance(
  allowanceId: string,
  worldId: string,
  stagingFd: FileHandle,
  stagingLock: LockHandle,
  deps: StagingDeps
): Promise<ConvertResult> {
  const stagingPath = stagingPathFor(deps.mediaRoot, allowanceId);

  // Get exact size via fstat (never trust client metadata).
  const stat = await stagingFd.stat();
  const sizeBytes = stat.size;
  if (sizeBytes <= 0 || sizeBytes > deps.maxStagingBytes) {
    throw new StagingAllowanceError(
      'STAGING_FILE_MISSING',
      `Invalid staged size: ${sizeBytes}`
    );
  }

  // Steps 2-6: DB transaction (allowance → reservation, .part created).
  const { reservationId } = await withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_quota:' || $1))`, [worldId]);
    await deps.lockWorldRow(worldId, tx);

    // Claim the allowance (handles 'active' and 'expiring').
    const claim = await tx.query(
      `UPDATE staging_allowances SET state = 'cancelled'
       WHERE allowance_id = $1 AND state IN ('active', 'expiring')
       RETURNING allowance_id`,
      [allowanceId]
    );
    if (claim.rows.length === 0) {
      throw new StagingAllowanceError(
        'STAGING_EXPIRED',
        `Allowance ${allowanceId} not available for conversion`
      );
    }

    // Re-check fence and backfill (could have activated during streaming).
    if (await deps.isFenceActive(tx)) {
      throw new StagingAllowanceError('FENCE_ACTIVE', 'Fence activated during upload');
    }
    if (await deps.isBackfillActive(tx)) {
      throw new StagingAllowanceError('BACKFILL_IN_PROGRESS', 'Backfill started during upload');
    }

    // Create reservation with bytes_ready=false (transfer not yet done).
    const res = await deps.createReservation(worldId, sizeBytes, false, tx);

    // Link allowance → reservation for orphan sweep / fence detection.
    await tx.query(
      `UPDATE staging_allowances SET reservation_id = $2 WHERE allowance_id = $1`,
      [allowanceId, res.reservationId]
    );

    // Rev 11: Create empty .part file BEFORE commit (stable lock file).
    const partPath = partPathFor(deps.mediaRoot, res.reservationId);
    const { mkdir, open: fsOpen } = await import('node:fs/promises');
    await mkdir(dirname(partPath), { recursive: true });
    const partFd = await fsOpen(partPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    await partFd.close();
    // Fsync parent dir for durability.
    const dirFd = await fsOpen(dirname(partPath), constants.O_RDONLY);
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }

    return res;
  });

  deps.log('info', 'Allowance converted to reservation', {
    allowanceId,
    reservationId,
    sizeBytes,
  });

  // Steps 7-9: Transfer bytes (outside DB txn, holding file locks).
  const partPath = partPathFor(deps.mediaRoot, reservationId);
  await transferStagingToPart(stagingPath, stagingFd, partPath, deps);

  // Set bytes_ready=true (no L1, bounded lock_timeout per rev 14).
  await setBytesReady(reservationId, deps);

  // Unlink staging file, release locks.
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(stagingPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await releaseLock(stagingLock);
  await stagingFd.close();

  return { reservationId, sizeBytes };
}

/**
 * Transfers bytes from staging file to .part file, preserving the .part inode.
 * Rev 12: Do NOT rename over .part (would replace inode and split locks).
 */
async function transferStagingToPart(
  stagingPath: string,
  stagingFd: FileHandle,
  partPath: string,
  deps: StagingDeps
): Promise<void> {
  // Acquire LOCK_EX on .part with bounded retry (rev 13).
  const partLock = await acquireExclusiveWithRetry(partPath, 30000, deps);
  try {
    const partFd = await open(partPath, constants.O_WRONLY, 0o644);
    try {
      // Copy bytes (staging → part). Use read/write loop for portability.
      // API-1 §9.3: Map I/O errors to STORAGE_WRITE_FAILED (distinct from quota/capacity).
      const CHUNK = 64 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let offset = 0;
      for (;;) {
        let bytesRead: number;
        try {
          ({ bytesRead } = await stagingFd.read(buf, 0, CHUNK, offset));
        } catch (err) {
          throw new StagingAllowanceError(
            'STORAGE_WRITE_FAILED',
            `Failed reading staging file: ${(err as Error).message}`
          );
        }
        if (bytesRead === 0) break;
        try {
          await partFd.write(buf.subarray(0, bytesRead), 0, bytesRead, offset);
        } catch (err) {
          throw new StagingAllowanceError(
            'STORAGE_WRITE_FAILED',
            `Failed writing part file: ${(err as Error).message}`
          );
        }
        offset += bytesRead;
      }
      try {
        await partFd.sync();
      } catch (err) {
        throw new StagingAllowanceError(
          'STORAGE_WRITE_FAILED',
          `Failed syncing part file: ${(err as Error).message}`
        );
      }
    } finally {
      await partFd.close();
    }
    // Fsync parent dir.
    const dirFd = await open(dirname(partPath), constants.O_RDONLY);
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }
  } finally {
    await releaseLock(partLock);
  }
  deps.log('info', 'Staging bytes transferred to .part', { partPath });
}

/**
 * Acquires an exclusive lock with bounded retry (no indefinite blocking).
 * Used for .part lock acquisition to avoid deadlock with fence activation.
 */
async function acquireExclusiveWithRetry(
  path: string,
  timeoutMs: number,
  deps: StagingDeps
): Promise<LockHandle> {
  const { LockContentionError } = await import('../../../../shared/fs/flock.js');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await acquireExclusiveNonBlocking(path);
    } catch (err) {
      if (!(err instanceof LockContentionError)) throw err;
      if (Date.now() >= deadline) {
        throw new StagingAllowanceError(
          'STAGING_FILE_MISSING',
          `Timed out acquiring lock on ${path}`
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/**
 * Sets bytes_ready=true after transfer. No L1 (single-row update).
 * Bounded lock_timeout; on timeout leaves flag false (safe).
 */
async function setBytesReady(reservationId: string, deps: StagingDeps): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '5s'`);
    const result = await tx.query(
      `UPDATE storage_reservations SET bytes_ready = true
       WHERE reservation_id = $1 AND state = 'RESERVED'
         AND bytes_ready = false AND expires_at > clock_timestamp()`,
      [reservationId]
    );
    if (result.rowCount === 0) {
      // Reservation was ABANDONED, expired, or already ready. Log and continue;
      // the caller will detect via Phase-2 refusal or RES-1c reaping.
      deps.log('warn', 'bytes_ready update affected 0 rows', { reservationId });
    }
  });
}

/**
 * Cancels an allowance (user abort or validation failure).
 * Deletes the staging file if no lock is held.
 */
export async function cancelAllowance(
  allowanceId: string,
  mediaRoot: string,
  deps: Pick<StagingDeps, 'log'>
): Promise<void> {
  const { query } = await import('../../../../shared/database/db.js');
  await query(
    `UPDATE staging_allowances SET state = 'cancelled'
     WHERE allowance_id = $1 AND state IN ('active', 'expiring')`,
    [allowanceId]
  );
  deps.log('info', 'Staging allowance cancelled', { allowanceId });
}
