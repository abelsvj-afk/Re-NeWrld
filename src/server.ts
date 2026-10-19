import { buildApp } from './app.js';
import { env } from './config/env.js';
import { runDeliveryOnce } from './modules/world/domain/services/delivery-worker.service.js';
import { sendAlertWebhook } from './modules/world/domain/services/alert-webhook.service.js';
import { runClaimTick } from './modules/world/domain/services/expiry-claim.service.js';
import { pool } from './shared/database/db.js';
import { getWorkerMetrics } from './shared/metrics/worker-metrics.js';
import { withTransaction } from './shared/database/db.js';
import { SessionService } from './modules/auth/infrastructure/services/session.service.js';
import { PostgresPasswordResetRepository } from './modules/auth/infrastructure/persistence/postgres-password-reset.repository.js';
import { PostgresIdempotencyRepository } from './modules/session/infrastructure/persistence/postgres-idempotency.repository.js';

// Hourly cleanup of expired sessions and expired password-reset tokens (keeps
// auth_sessions and password_reset_tokens from growing unbounded). In-process
// interval — not the Phase L BullMQ queue, which is reserved for
// simulation/analytics workloads.
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function startSessionJanitor(app: { log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void } }): void {
  const sessionService = new SessionService();
  const resetRepository = new PostgresPasswordResetRepository();
  const idempotencyRepository = new PostgresIdempotencyRepository();

  const run = async () => {
    try {
      const removed = await sessionService.cleanupExpiredSessions();
      if (removed > 0) {
        app.log.info({ removed }, 'Cleaned up expired sessions');
      }
      const removedTokens = await resetRepository.deleteExpired();
      if (removedTokens > 0) {
        app.log.info({ removedTokens }, 'Cleaned up expired password-reset tokens');
      }
      const removedKeys = await idempotencyRepository.deleteExpired();
      if (removedKeys > 0) {
        app.log.info({ removedKeys }, 'Cleaned up expired idempotency keys');
      }
    } catch (err) {
      app.log.error({ err }, 'Expired session cleanup failed');
    }
  };

  void run();
  const timer = setInterval(run, SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();
}

/**
 * Starts the RES-1c expiry claim worker.
 *
 * Every 60 seconds, discovers expired reservations and claims them.
 * Single-flight guard prevents overlap.
 */
function startExpiryClaimWorker(app: {
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}): void {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const deps = {
        mediaRoot: process.env.MEDIA_ROOT || '/data/media',
        withTransaction,
        query: async (sql: string, params?: unknown[]) => {
          const result = await pool.query(sql, params);
          return { rows: result.rows, rowCount: result.rowCount };
        },
        log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
          app.log[level](data || {}, msg);
        },
        // B2: Real metrics wired — required by ExpiryClaimDeps.
        metrics: {
          claimsTotal: { inc: () => getWorkerMetrics().expiryClaimsTotal.inc() },
          skipsTotal: { inc: () => getWorkerMetrics().expiryClaimSkipsTotal.inc() },
          errorsTotal: { inc: () => getWorkerMetrics().expiryClaimErrorsTotal.inc() },
        },
      };
      await runClaimTick(deps);
    } catch (err) {
      app.log.error({ err }, 'Expiry claim tick failed');
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, 60 * 1000); // Every 60 seconds.
  timer.unref();
}

/**
 * Starts the world deletion recovery worker (DEL-2).
 *
 * Polls world_deletion_jobs for stuck jobs and resumes them.
 * Uses session-level advisory lock for single-instance guarantee.
 */
async function startWorldDeletionRecovery(app: {
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}): Promise<void> {
  const { startDeletionRecoveryWorker } = await import(
    './modules/world/domain/services/world-deletion-recovery.service.js'
  );
  const { env } = await import('./config/env.js');
  startDeletionRecoveryWorker({
    mediaRoot: env.MEDIA_STORAGE_PATH,
    isFenceActive: async (tx: any) => {
      const r = await tx.query(`SELECT active FROM system_maintenance WHERE id = 1`);
      return r.rows.length > 0 && r.rows[0].active === true;
    },
    isBackfillActive: async (tx: any) => {
      const r = await tx.query(`SELECT 1 FROM backfill_runs WHERE state = 'in_progress' LIMIT 1`);
      return r.rows.length > 0;
    },
    log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
      app.log[level]({ ...data, worker: 'world-deletion-recovery' }, msg);
    },
  });
}

/**
 * Starts the temp-cleanup alert delivery worker.
 *
 * Polls the delivery outbox every 30 seconds, claims pending events,
 * and sends notifications. Runs in-process (like the session janitor).
 *
 * Boundary: The cleanup service creates durable outbox events transactionally
 * with the failure counters. This worker claims and delivers them. The two
 * are decoupled — event creation never blocks on delivery, and delivery
 * retries independently via the outbox protocol.
 */
function startDeliveryWorker(app: {
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}): void {
  const workerId = `delivery-${process.pid}`;
  let running = false;

  const run = async () => {
    if (running) return; // Prevent overlap.
    running = true;
    try {
      const deps = {
        withTransaction,
        workerId,
        log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
          app.log[level]({ ...data, workerId }, msg);
        },
        // B8: Real delivery via extracted webhook service.
        // Throws on invalid config, timeout, or non-2xx → event stays pending.
        send: async (event: {
          delivery_event_id: string;
          incident_id: string;
          reservation_id: string;
          failure_type: 'unlink' | 'fsync';
          fire_count: number;
          severity: 'warning' | 'critical';
        }) => {
          await sendAlertWebhook(process.env.ALERT_WEBHOOK_URL, event);
          app.log.info(
            { deliveryEventId: event.delivery_event_id },
            'Alert delivered via webhook',
          );
        },
        // Delivery metrics wired to the shared singleton.
        metrics: {
          sentTotal: { inc: () => getWorkerMetrics().deliverySentTotal.inc() },
          failedTotal: { inc: () => getWorkerMetrics().deliveryFailedTotal.inc() },
        },
      };

      // Process up to 10 events per tick.
      for (let i = 0; i < 10; i++) {
        const didWork = await runDeliveryOnce(deps);
        if (!didWork) break;
      }
    } catch (err) {
      app.log.error({ err, workerId }, 'Delivery worker iteration failed');
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, 30 * 1000); // Every 30 seconds.
  timer.unref();
}

async function start() {
  try {
    const app = await buildApp();
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Server listening on http://${env.HOST}:${env.PORT}`);
    startSessionJanitor(app);
    startDeliveryWorker(app);
    startExpiryClaimWorker(app);
    await startWorldDeletionRecovery(app);

    // Graceful shutdown on SIGTERM/SIGINT (Fly.io scale-to-zero)
    const shutdown = async (signal: string) => {
      app.log.info(`Received ${signal}, shutting down gracefully`);
      try {
        await app.close();
        app.log.info('Server closed');
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
