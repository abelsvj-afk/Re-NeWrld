/**
 * RES-1b Phase-2 Writer Obligations (ADR-017)
 *
 * Implements the deterministic temp path, single-writer ownership, heartbeats,
 * and fenced chunk writes per ADR-017-res-1b-design.md rev 30.
 *
 * Does NOT include: expiry-claim worker (RES-1c), registry handoff (QUOTA-1).
 */

import { open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { join } from 'node:path';
import {
  acquireExclusiveNonBlocking,
  acquireShared,
  releaseLock,
  LockContentionError,
  type LockHandle,
} from '../../../../shared/fs/flock.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WriterErrorCode =
  | 'WRITER_CONFLICT'      // Another writer owns this reservation (409)
  | 'RESERVATION_INACTIVE' // Reservation not in RESERVED/WRITING or released
  | 'HEARTBEAT_FAILED'     // Heartbeat updated 0 rows; reservation no longer active
  | 'FENCED_WRITE_REJECTED' // State changed under lock; write aborted
  | 'TRANSFER_INCOMPLETE'  // bytes_ready=false; initial transfer not done (UPLOAD-1)
  | 'FENCE_ACTIVE'         // Maintenance fence active; writes rejected (UPLOAD-1)
  | 'STORAGE_WRITE_FAILED'; // Filesystem I/O error during write (API-1 §9.3)

export class Phase2WriterError extends Error {
  public readonly code: WriterErrorCode;
  public readonly httpStatus: number;

  constructor(code: WriterErrorCode, message: string) {
    super(message);
    this.name = 'Phase2WriterError';
    this.code = code;
    this.httpStatus =
      code === 'WRITER_CONFLICT' ? 409 :
      code === 'FENCE_ACTIVE' ? 503 :
      code === 'TRANSFER_INCOMPLETE' ? 500 :
      code === 'STORAGE_WRITE_FAILED' ? 500 : 410;
  }
}

export interface Phase2WriterDeps {
  /** Base directory for media storage (e.g., /data/media). */
  mediaRoot: string;
  /** Validates reservation is active; returns true if state in (RESERVED, WRITING) and released_at IS NULL. */
  isReservationActive: (reservationId: string) => Promise<boolean>;
  /**
   * UPLOAD-1: Returns reservation write eligibility.
   * Checks state, bytes_ready flag, and fence under the caller's lock.
   * Returns { eligible, reason } — reason is set when not eligible.
   */
  checkWriteEligibility?: (reservationId: string) => Promise<{
    eligible: boolean;
    reason?: 'INACTIVE' | 'TRANSFER_INCOMPLETE' | 'FENCE_ACTIVE';
  }>;
  /** Executes heartbeat UPDATE; returns number of rows affected. */
  heartbeat: (reservationId: string) => Promise<number>;
  /** Logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

export interface WriterSession {
  reservationId: string;
  tempPath: string;
  lockPath: string;
  bytesWritten: number;
  digest: Hash;
  /** Kernel-held exclusive lock on the lockfile. Released on close. */
  ownershipLock: LockHandle;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Deterministic temp path: {mediaRoot}/.tmp/{reservation_id}.part */
export function tempPathFor(mediaRoot: string, reservationId: string): string {
  return join(mediaRoot, '.tmp', `${reservationId}.part`);
}

/** Ownership lockfile path: {mediaRoot}/.tmp/{reservation_id}.lock */
export function lockPathFor(mediaRoot: string, reservationId: string): string {
  return join(mediaRoot, '.tmp', `${reservationId}.lock`);
}

// ---------------------------------------------------------------------------
// Writer session
// ---------------------------------------------------------------------------

/**
 * Opens a writer session for a reservation.
 *
 * Protocol (§1.1a):
 * 1. Validate reservation is active BEFORE acquiring lock.
 * 2. Open (or create) lockfile with O_CREAT|O_RDWR.
 * 3. Acquire flock(LOCK_EX|LOCK_NB) on lockfile.
 * 4. If EWOULDBLOCK → WRITER_CONFLICT (409).
 * 5. Open temp data file with O_CREAT|O_WRONLY|O_APPEND.
 *
 * The ownership lock is held for the ENTIRE upload.
 * The lockfile is NEVER unlinked (permanent, rev 4).
 */
export async function openWriterSession(
  reservationId: string,
  deps: Phase2WriterDeps,
): Promise<{ session: WriterSession; dataFd: FileHandle; lockFd: FileHandle }> {
  // Step 1: Validate reservation active BEFORE acquiring lock.
  const active = await deps.isReservationActive(reservationId);
  if (!active) {
    throw new Phase2WriterError(
      'RESERVATION_INACTIVE',
      `Reservation ${reservationId} is not active; cannot open writer session`,
    );
  }

  const lockPath = lockPathFor(deps.mediaRoot, reservationId);
  const tempPath = tempPathFor(deps.mediaRoot, reservationId);

  // Step 2: Open (or create) lockfile.
  let lockFd: FileHandle;
  try {
    lockFd = await open(lockPath, constants.O_CREAT | constants.O_RDWR, 0o644);
  } catch (err) {
    throw new Phase2WriterError(
      'RESERVATION_INACTIVE',
      `Failed to open lockfile for ${reservationId}: ${(err as Error).message}`,
    );
  }

  // Step 3: Acquire exclusive non-blocking kernel lock via flock(1).
  // Spawns `flock -n <lockfile> sleep infinity`. If already locked, throws.
  let ownershipLock: LockHandle;
  try {
    ownershipLock = await acquireExclusiveNonBlocking(lockPath);
  } catch (err) {
    if (err instanceof LockContentionError) {
      await lockFd.close();
      throw new Phase2WriterError(
        'WRITER_CONFLICT',
        `Reservation ${reservationId} already owned by another writer`,
      );
    }
    // Verification, spawn, or timeout failures are NOT contention.
    // Fail closed — do not treat as "another writer".
    throw err;
  }
  // Close the Node fd; the flock child process holds the lock via its own fd.
  await lockFd.close();

  deps.log('info', 'Writer session opened (ownership lock held)', { reservationId, tempPath });

  // Step 5: Open temp data file.
  const dataFd = await open(tempPath, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o644);

  const session: WriterSession = {
    reservationId,
    tempPath,
    lockPath,
    bytesWritten: 0,
    digest: createHash('sha256'),
    ownershipLock,
  };

  // lockFd is closed; return a dummy for API compat (ownership is via flock child).
  return { session, dataFd, lockFd: null as unknown as FileHandle };
}

/**
 * Writes a chunk with fencing (§1.3).
 *
 * Per-chunk protocol (exact order):
 * 1. flock(fd, LOCK_SH) — shared lock on temp file.
 * 2. SELECT state, released_at — re-validate under lock.
 * 3. If not active → unlock, abort. No bytes written.
 * 4. write(fd, chunk) — single syscall.
 * 5. flock(fd, LOCK_UN) — release immediately.
 *
 * The heartbeat proves liveness, NOT write permission. Each chunk is
 * authorized by the validation under LOCK_SH (the fencing-authority race).
 */
export async function writeChunkFenced(
  session: WriterSession,
  dataFd: FileHandle,
  chunk: Buffer,
  deps: Phase2WriterDeps,
): Promise<void> {
  // Step 1: Acquire shared kernel lock on temp file.
  // Hold during validate+write; release immediately after.
  const shLock = await acquireShared(session.tempPath);
  try {
    // Step 2: Re-validate under lock.
    // UPLOAD-1: Use checkWriteEligibility if available (checks bytes_ready + fence).
    // Otherwise fall back to isReservationActive (pre-UPLOAD-1 behavior).
    if (deps.checkWriteEligibility) {
      const { eligible, reason } = await deps.checkWriteEligibility(session.reservationId);
      if (!eligible) {
        const code = reason === 'TRANSFER_INCOMPLETE' ? 'TRANSFER_INCOMPLETE'
          : reason === 'FENCE_ACTIVE' ? 'FENCE_ACTIVE'
          : 'FENCED_WRITE_REJECTED';
        throw new Phase2WriterError(
          code,
          `Write rejected for ${session.reservationId}: ${reason}`,
        );
      }
    } else {
      const active = await deps.isReservationActive(session.reservationId);
      if (!active) {
        // Step 3: Abort. No bytes written.
        throw new Phase2WriterError(
          'FENCED_WRITE_REJECTED',
          `Reservation ${session.reservationId} became inactive during write; chunk rejected`,
        );
      }
    }

    // Step 4: Write (single syscall).
    // API-1 §9.3: Map I/O errors to STORAGE_WRITE_FAILED (distinct from quota/capacity).
    try {
      await dataFd.write(chunk);
    } catch (err) {
      throw new Phase2WriterError(
        'STORAGE_WRITE_FAILED',
        `Filesystem write failed for ${session.reservationId}: ${(err as Error).message}`,
      );
    }
    session.bytesWritten += chunk.length;
    session.digest.update(chunk);
  } finally {
    // Step 5: Release shared lock immediately.
    await releaseLock(shLock);
  }

  deps.log('info', 'Chunk written (fenced)', {
    reservationId: session.reservationId,
    bytes: chunk.length,
    total: session.bytesWritten,
  });
}

/**
 * Sends a heartbeat (§1.2).
 *
 * UPDATE storage_reservations SET epoch=epoch+1, expires_at=now()+5min,
 *   last_heartbeat_at=now() WHERE reservation_id=? AND released_at IS NULL.
 *
 * If 0 rows → reservation no longer active → abort immediately.
 */
export async function sendHeartbeat(
  session: WriterSession,
  deps: Phase2WriterDeps,
): Promise<void> {
  const rows = await deps.heartbeat(session.reservationId);
  if (rows === 0) {
    throw new Phase2WriterError(
      'HEARTBEAT_FAILED',
      `Heartbeat for ${session.reservationId} updated 0 rows; reservation no longer active`,
    );
  }
  deps.log('info', 'Heartbeat sent', { reservationId: session.reservationId });
}

/**
 * Closes a writer session, releasing the ownership lock.
 * The lockfile is NEVER unlinked (permanent, rev 4).
 */
export async function closeWriterSession(
  session: WriterSession,
  dataFd: FileHandle,
  _lockFd: FileHandle | null,
  deps: Phase2WriterDeps,
): Promise<void> {
  await dataFd.close();
  // Release ownership lock by killing the flock holder.
  // The kernel releases LOCK_EX when the process dies.
  // The lockfile itself is NEVER unlinked (permanent, rev 4).
  await releaseLock(session.ownershipLock);
  deps.log('info', 'Writer session closed (ownership released)', {
    reservationId: session.reservationId,
  });
}
