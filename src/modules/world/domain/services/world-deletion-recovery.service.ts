/**
 * DEL-2: Crash recovery worker for world deletion jobs.
 *
 * Monitors `world_deletion_jobs` for jobs stuck in non-terminal states
 * and resumes them from the appropriate transaction.
 *
 * Runs as a background poller (every 60s). Uses a session-level advisory
 * lock to ensure single instance.
 */

import type pkg from 'pg';
import { query } from '../../../../shared/database/db.js';
import {
  worldDeletionT2,
  worldDeletionT3,
  worldDeletionT4,
  worldDeletionT5,
  type WorldDeletionDeps,
} from './world-deletion.service.js';

const WORKER_LOCK_KEY = 'world_deletion_worker';
const POLL_INTERVAL_MS = 60_000;

let pollTimer: NodeJS.Timeout | null = null;
let isRunning = false;

export function startDeletionRecoveryWorker(deps: WorldDeletionDeps): void {
  if (pollTimer) return; // Already running

  const poll = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await recoverStuckJobs(deps);
    } catch (err) {
      deps.log('error', 'Deletion recovery worker error', {
        error: (err as Error).message,
      });
    } finally {
      isRunning = false;
    }
  };

  // Run immediately, then on interval
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  deps.log('info', 'World deletion recovery worker started');
}

export function stopDeletionRecoveryWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function recoverStuckJobs(deps: WorldDeletionDeps): Promise<void> {
  // Try to acquire worker lock (session-level, not xact)
  // Use a dedicated query to attempt the lock
  const lockResult = await query(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
    [WORKER_LOCK_KEY]
  );

  if (!lockResult.rows[0].acquired) {
    // Another worker instance is running
    return;
  }

  try {
    // Find stuck jobs (not complete, not failed, updated > 5 min ago)
    // The 5-min threshold avoids racing with an in-progress deletion
    const stuck = await query(
      `SELECT job_id, world_id, state FROM world_deletion_jobs
       WHERE state NOT IN ('complete', 'failed')
         AND updated_at < now() - interval '5 minutes'
       ORDER BY updated_at ASC
       LIMIT 10`
    );

    for (const job of stuck.rows) {
      const jobId = job.job_id as string;
      const worldId = job.world_id as string;
      const state = job.state as string;

      deps.log('info', 'Resuming stuck deletion job', { jobId, worldId, state });

      try {
        switch (state) {
          case 't1_complete':
            await worldDeletionT2(jobId, worldId, deps);
            // Fall through to T3, T4, T5
            await worldDeletionT3(jobId, worldId, deps);
            await worldDeletionT4(jobId, worldId, deps);
            await worldDeletionT5(jobId, worldId, deps);
            break;
          case 't2_complete':
            await worldDeletionT3(jobId, worldId, deps);
            await worldDeletionT4(jobId, worldId, deps);
            await worldDeletionT5(jobId, worldId, deps);
            break;
          case 't3_complete':
            await worldDeletionT4(jobId, worldId, deps);
            await worldDeletionT5(jobId, worldId, deps);
            break;
          case 't4_complete':
            await worldDeletionT5(jobId, worldId, deps);
            break;
          default:
            deps.log('warn', 'Unknown job state', { jobId, state });
        }
        deps.log('info', 'Stuck job recovered', { jobId });
      } catch (err) {
        deps.log('error', 'Failed to recover job', {
          jobId,
          error: (err as Error).message,
        });
        // Mark as failed for operator intervention
        await query(
          `UPDATE world_deletion_jobs
           SET state = 'failed', error = $2, updated_at = now()
           WHERE job_id = $1`,
          [jobId, (err as Error).message]
        );
      }
    }
  } finally {
    // Release worker lock
    await query(`SELECT pg_advisory_unlock(hashtext($1))`, [WORKER_LOCK_KEY]);
  }
}
