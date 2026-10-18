/**
 * Minimal in-memory metrics for background workers.
 *
 * The project has no Prometheus client yet. These counters provide the
 * operational observability the designs require (RES-1b §1.6e, RES-1c §6).
 * Values are exposed via the /health endpoint's worker section.
 */

export interface Counter {
  inc(labels?: Record<string, string>): void;
  get(): number;
}

function createCounter(): Counter {
  let value = 0;
  return {
    inc: () => { value++; },
    get: () => value,
  };
}

export interface WorkerMetrics {
  expiryClaimsTotal: Counter;
  expiryClaimSkipsTotal: Counter;
  expiryClaimErrorsTotal: Counter;
  deliverySentTotal: Counter;
  deliveryFailedTotal: Counter;
}

export function createWorkerMetrics(): WorkerMetrics {
  return {
    expiryClaimsTotal: createCounter(),
    expiryClaimSkipsTotal: createCounter(),
    expiryClaimErrorsTotal: createCounter(),
    deliverySentTotal: createCounter(),
    deliveryFailedTotal: createCounter(),
  };
}

// Singleton for the running server.
let instance: WorkerMetrics | null = null;

export function getWorkerMetrics(): WorkerMetrics {
  if (!instance) instance = createWorkerMetrics();
  return instance;
}
