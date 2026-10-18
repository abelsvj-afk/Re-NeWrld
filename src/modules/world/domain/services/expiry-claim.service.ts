/**
 * RES-1c Expiry Claim Worker (ADR-017 §5.5, design rev 3)
 *
 * Reaps expired storage reservations (crashed/stalled writers) so they
 * stop pinning quota.
 *
 * Claim protocol (per design §2):
 * 1. Discovery: SELECT candidates in own tx (commits immediately).
 * 2. Per candidate: acquire ownership lock (LOCK_EX|LOCK_NB).
 *    - LockContentionError → writer alive → skip.
 *    - Other lock errors → fail closed (log, metric, skip).
 * 3. CAS finalize: UPDATE ... WHERE epoch=$E1 AND released_at IS NULL.
 *    - 0 rows → heartbeat won race → skip.
 *    - 1 row → ABANDONED, quota freed atomically.
 * 4. Unlink temp .part (best-effort; never touch .lock file).
 * 5. Release lock.
 */

import { unlink } from 'node:fs/promises';
import type pkg from 'pg';
import {
  acquireExclusiveNonBlocking,
  releaseLock,
  LockContentionError,
  type LockHandle,
} from '../../../../shared/fs/flock.js';
import { lockPathFor, tempPathFor } from './phase2-writer.service.js';

export interface ExpiryClaimDeps {
  mediaRoot: string;
  withTransaction: <T>(fn: (tx: pkg.PoolClient) => Promise<T>) => Promise<T>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
  // B2: metrics are REQUIRED, not optional. The production worker must
  // always provide them; tests provide a real or stub implementation.
  metrics: {
    claimsTotal: { inc: () => void };
    skipsTotal: { inc: (labels: { reason: string }) => void };
    errorsTotal: { inc: () => void };
  };
}

/** No-op metrics for tests that don't assert on counts. */
export function noopMetrics() {
  return {
    claimsTotal: { inc: () => {} },
    skipsTotal: { inc: (_labels: { reason: string }) => {} },
    errorsTotal: { inc: () => {} },
  };
}

export interface ClaimCandidate {
  reservation_id: string;
  epoch: number;
  world_id: string;
  size_bytes: number;
}

/** Observation window: only claim reservations expired >30s ago. */
const OBSERVATION_WINDOW_SQL = `interval '30 seconds'`;
const BATCH_SIZE = 100;

/**
 * Discovers claim candidates. Runs in its own transaction which commits
 * immediately — no DB locks held during per-candidate processing.
 */
export async function discoverCandidates(
  deps: ExpiryClaimDeps,
): Promise<ClaimCandidate[]> {
  const result = await deps.withTransaction(async (tx) => {
    return tx.query(
      `SELECT reservation_id, epoch, world_id, size_bytes
         FROM storage_reservations
        WHERE state IN ('RESERVED', 'WRITING')
          AND expires_at < now() - ${OBSERVATION_WINDOW_SQL}
        ORDER BY expires_at
        LIMIT ${BATCH_SIZE}`,
    );
  });
  return result.rows.map((r) => ({
    reservation_id: r.reservation_id as string,
    epoch: Number(r.epoch),
    world_id: r.world_id as string,
    size_bytes: Number(r.size_bytes),
  }));
}

/**
 * Attempts to claim a single candidate.
 * Returns 'claimed' | 'skipped' | 'error'.
 */
export async function claimOne(
  candidate: ClaimCandidate,
  deps: ExpiryClaimDeps,
): Promise<'claimed' | 'skipped' | 'error'> {
  const { reservation_id } = candidate;
  const lockPath = lockPathFor(deps.mediaRoot, reservation_id);

  // Step 2: Acquire ownership lock.
  let lock: LockHandle;
  try {
    lock = await acquireExclusiveNonBlocking(lockPath);
  } catch (err) {
    if (err instanceof LockContentionError) {
      deps.log('info', 'Expiry claim skipped: writer active', { reservation_id });
      deps.metrics.skipsTotal.inc({ reason: 'lock_held' });
      return 'skipped';
    }
    // Non-contention lock failure → fail closed.
    deps.log('error', 'Expiry claim lock failure', {
      reservation_id,
      error: (err as Error).message,
      errorName: (err as Error).name,
    });
    deps.metrics.errorsTotal.inc();
    return 'error';
  }

  try {
    // Step 3: CAS finalize.
    const claimed = await deps.withTransaction(async (tx) => {
      const result = await tx.query(
        `UPDATE storage_reservations
            SET state = 'ABANDONED',
                released_at = now(),
                claim_epoch = $2,
                claim_finalized_at = now()
          WHERE reservation_id = $1
            AND epoch = $2
            AND released_at IS NULL
            AND state IN ('RESERVED', 'WRITING')`,
        [reservation_id, candidate.epoch],
      );
      return (result.rowCount ?? 0) > 0;
    });

    if (!claimed) {
      deps.log('info', 'Expiry claim skipped: epoch advanced or state changed', {
        reservation_id,
      });
      deps.metrics.skipsTotal.inc({ reason: 'epoch_advanced' });
      return 'skipped';
    }

    deps.log('info', 'Reservation claimed as abandoned', {
      reservation_id,
      world_id: candidate.world_id,
      size_bytes: candidate.size_bytes,
      claim_epoch: candidate.epoch,
    });
    deps.metrics.claimsTotal.inc();

    // Step 4: Temp file cleanup (best-effort).
    const tempPath = tempPathFor(deps.mediaRoot, reservation_id);
    try {
      await unlink(tempPath);
      deps.log('info', 'Temp file cleaned up', { reservation_id });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        deps.log('warn', 'TEMP_CLEANUP_FAILED', {
          reservation_id,
          error: (err as Error).message,
        });
        // Leave for abandoned-temp job. Quota already freed.
      }
    }

    return 'claimed';
  } finally {
    // Step 5: Release lock.
    await releaseLock(lock);
  }
}

/**
 * Runs one claim worker tick: discover → claim each candidate.
 * Returns counts.
 */
export async function runClaimTick(
  deps: ExpiryClaimDeps,
): Promise<{ claimed: number; skipped: number; errors: number }> {
  const candidates = await discoverCandidates(deps);
  let claimed = 0;
  let skipped = 0;
  let errors = 0;

  for (const candidate of candidates) {
    const result = await claimOne(candidate, deps);
    if (result === 'claimed') claimed++;
    else if (result === 'skipped') skipped++;
    else errors++;
  }

  if (claimed > 0 || errors > 0) {
    deps.log('info', 'Claim tick complete', { claimed, skipped, errors });
  }

  return { claimed, skipped, errors };
}
