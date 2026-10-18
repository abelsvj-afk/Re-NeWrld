import { buildApp } from './app.js';
import { env } from './config/env.js';
import { runDeliveryOnce } from './modules/world/domain/services/delivery-worker.service.js';
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
        // B8: Real delivery — not just logging.
        // If ALERT_WEBHOOK_URL is configured, POST the event and require 2xx.
        // If not configured, THROW to keep the event pending (do NOT mark sent).
        // Marking sent without actual delivery would lose the alert.
        send: async (event: {
          delivery_event_id: string;
          incident_id: string;
          reservation_id: string;
          failure_type: string;
          fire_count: number;
          severity: string;
        }) => {
          const webhookUrl = process.env.ALERT_WEBHOOK_URL;
          if (!webhookUrl) {
            // No webhook configured: fail the send so the event stays pending
            // and retries with backoff. Logging alone is NOT delivery.
            throw new Error(
              'ALERT_WEBHOOK_URL not configured; event remains pending for retry',
            );
          }
          const resp = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              delivery_event_id: event.delivery_event_id,
              incident_id: event.incident_id,
              reservation_id: event.reservation_id,
              failure_type: event.failure_type,
              fire_count: event.fire_count,
              severity: event.severity,
              source: 're-newrld-temp-cleanup',
            }),
          });
          if (!resp.ok) {
            throw new Error(`Webhook returned ${resp.status}: ${await resp.text()}`);
          }
          app.log.info(
            { deliveryEventId: event.delivery_event_id },
            'Alert delivered via webhook',
          );
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
