/**
 * RES-1b Alert Webhook Sender (ADR-017 §1.6e)
 *
 * Sends alert notifications to a configured webhook URL.
 * Used by the delivery worker in server.ts.
 *
 * Extracted for testability: the integration tests exercise this
 * against a local mock HTTP server (success, non-2xx, timeout, invalid URL).
 */

export interface AlertPayload {
  delivery_event_id: string;
  incident_id: string;
  reservation_id: string;
  failure_type: 'unlink' | 'fsync';
  fire_count: number;
  severity: 'warning' | 'critical';
}

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookError';
  }
}

const WEBHOOK_TIMEOUT_MS = 10000;

/**
 * Validates the webhook URL. Throws WebhookError if invalid.
 */
export function validateWebhookUrl(urlString: string | undefined): URL {
  if (!urlString) {
    throw new WebhookError('ALERT_WEBHOOK_URL not configured');
  }
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new WebhookError(`ALERT_WEBHOOK_URL is not a valid URL: ${urlString}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookError(`ALERT_WEBHOOK_URL must be http(s): ${urlString}`);
  }
  return url;
}

/**
 * Sends an alert payload to the webhook URL.
 *
 * @throws WebhookError on invalid config, timeout, network error, or non-2xx.
 */
export async function sendAlertWebhook(
  webhookUrl: string | undefined,
  payload: AlertPayload,
): Promise<void> {
  const url = validateWebhookUrl(webhookUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, source: 're-newrld-temp-cleanup' }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new WebhookError(`Webhook returned ${resp.status}: ${body}`);
    }
  } catch (err) {
    if (err instanceof WebhookError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new WebhookError(`Webhook timed out after ${WEBHOOK_TIMEOUT_MS}ms`);
    }
    throw new WebhookError(`Webhook failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}
