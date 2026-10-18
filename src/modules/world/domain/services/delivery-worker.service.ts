/**
 * RES-1b Outbox Delivery Worker (ADR-017 §1.6e, rev 25-30)
 *
 * Delivers alert notifications from the temp_cleanup_delivery_outbox.
 *
 * Protocol:
 * 1. Claim: SELECT pending event WHERE next_attempt_at <= now(), FOR UPDATE SKIP LOCKED.
 *    Set claimed_by, claimed_at, claim_token (UUID). Stale claims (>5min) reclaimable.
 * 2. Send: transmit to notifier with delivery_event_id as dedup key.
 * 3. Confirm (fenced): UPDATE ... SET status='sent' WHERE delivery_event_id=? AND claim_token=?.
 * 4. Retry (fenced): on failure, increment attempts, set next_attempt_at per backoff.
 *    - attempts 0-8: remain pending.
 *    - attempts 9→10: transition to 'failed' (single conditional transaction).
 * 5. Receiver deduplicates on delivery_event_id (not incident_id).
 */

import { randomUUID } from 'node:crypto';
import type pkg from 'pg';

export interface DeliveryWorkerDeps {
  withTransaction: <T>(fn: (tx: pkg.PoolClient) => Promise<T>) => Promise<T>;
  /** Sends the notification; throws on failure. */
  send: (event: OutboxEvent) => Promise<void>;
  workerId: string;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

export interface OutboxEvent {
  delivery_event_id: string;
  incident_id: string;
  reservation_id: string;
  failure_type: 'unlink' | 'fsync';
  fire_count: number;
  severity: 'warning' | 'critical';
}

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 10;

/** Backoff schedule: attempts 0→1min, 1→5min, 2→15min, 3→30min, 4+→1hr. */
function backoffFor(attempts: number): string {
  if (attempts === 0) return `interval '1 minute'`;
  if (attempts === 1) return `interval '5 minutes'`;
  if (attempts === 2) return `interval '15 minutes'`;
  if (attempts === 3) return `interval '30 minutes'`;
  return `interval '1 hour'`;
}

/**
 * Claims one pending delivery event.
 * Returns the event with its claim token, or null if none available.
 */
export async function claimDeliveryEvent(
  deps: DeliveryWorkerDeps,
  tx: pkg.PoolClient,
): Promise<{ event: OutboxEvent; claimToken: string } | null> {
  const claimToken = randomUUID();

  const result = await tx.query(
    `UPDATE temp_cleanup_delivery_outbox
       SET claimed_by=$1, claimed_at=now(), claim_token=$2::uuid
     WHERE delivery_event_id = (
       SELECT delivery_event_id FROM temp_cleanup_delivery_outbox
       WHERE status='pending'
         AND next_attempt_at <= now()
         AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING delivery_event_id, incident_id, reservation_id, failure_type, fire_count, severity`,
    [deps.workerId, claimToken],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  return {
    event: {
      delivery_event_id: row.delivery_event_id,
      incident_id: row.incident_id,
      reservation_id: row.reservation_id,
      failure_type: row.failure_type,
      fire_count: row.fire_count,
      severity: row.severity,
    },
    claimToken,
  };
}

/**
 * Marks an event as sent (fenced by claim token).
 * Returns true if the update succeeded (claim still valid).
 */
export async function confirmDelivery(
  deliveryEventId: string,
  claimToken: string,
  tx: pkg.PoolClient,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE temp_cleanup_delivery_outbox
       SET status='sent', sent_at=now(), claimed_by=NULL, claimed_at=NULL, claim_token=NULL
     WHERE delivery_event_id=$1 AND claim_token=$2::uuid AND status='pending'`,
    [deliveryEventId, claimToken],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Handles a send failure (fenced by claim token).
 * Atomically chooses between retry (attempts 0-8) and exhaustion (attempts 9→10).
 *
 * Returns 'retried' | 'failed' | 'superseded'.
 */
export async function handleDeliveryFailure(
  deliveryEventId: string,
  claimToken: string,
  errorMessage: string,
  tx: pkg.PoolClient,
): Promise<'retried' | 'failed' | 'superseded'> {
  // Case A: attempts 0-8 → increment, schedule backoff, remain pending.
  const retryResult = await tx.query(
    `UPDATE temp_cleanup_delivery_outbox
       SET attempts = attempts + 1,
           last_attempt_at = now(),
           last_error = $3,
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
           next_attempt_at = now() + (CASE
             WHEN attempts = 0 THEN interval '1 minute'
             WHEN attempts = 1 THEN interval '5 minutes'
             WHEN attempts = 2 THEN interval '15 minutes'
             WHEN attempts = 3 THEN interval '30 minutes'
             ELSE interval '1 hour' END)
     WHERE delivery_event_id = $1
       AND claim_token = $2::uuid
       AND status = 'pending'
       AND attempts < 9
     RETURNING delivery_event_id`,
    [deliveryEventId, claimToken, errorMessage],
  );

  if ((retryResult.rowCount ?? 0) > 0) return 'retried';

  // Case B: attempts = 9 → transition to failed.
  const failResult = await tx.query(
    `UPDATE temp_cleanup_delivery_outbox
       SET status = 'failed',
           attempts = 10,
           last_attempt_at = now(),
           last_error = $3,
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL
     WHERE delivery_event_id = $1
       AND claim_token = $2::uuid
       AND status = 'pending'
       AND attempts = 9
     RETURNING delivery_event_id`,
    [deliveryEventId, claimToken, errorMessage],
  );

  if ((failResult.rowCount ?? 0) > 0) return 'failed';

  // Neither matched → claim superseded.
  return 'superseded';
}

/**
 * Runs one delivery worker iteration: claim → send → confirm/fail.
 */
export async function runDeliveryOnce(deps: DeliveryWorkerDeps): Promise<boolean> {
  return deps.withTransaction(async (tx) => {
    const claimed = await claimDeliveryEvent(deps, tx);
    if (!claimed) return false; // No work.

    const { event, claimToken } = claimed;

    try {
      await deps.send(event);
      const confirmed = await confirmDelivery(event.delivery_event_id, claimToken, tx);
      if (!confirmed) {
        deps.log('warn', 'Claim superseded during send', {
          deliveryEventId: event.delivery_event_id,
        });
      } else {
        deps.log('info', 'Delivery confirmed', {
          deliveryEventId: event.delivery_event_id,
          incidentId: event.incident_id,
        });
      }
    } catch (err) {
      const outcome = await handleDeliveryFailure(
        event.delivery_event_id,
        claimToken,
        (err as Error).message,
        tx,
      );
      deps.log(outcome === 'failed' ? 'error' : 'warn', `Delivery ${outcome}`, {
        deliveryEventId: event.delivery_event_id,
        outcome,
      });
      if (outcome === 'failed') {
        // Log critical for exhausted deliveries.
        deps.log('error', 'ALERT_DELIVERY_FAILED', {
          deliveryEventId: event.delivery_event_id,
          incidentId: event.incident_id,
          attempts: MAX_ATTEMPTS,
        });
      }
    }

    return true;
  });
}
