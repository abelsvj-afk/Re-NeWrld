-- UPLOAD-1: Staging allowances for bounded pre-reservation uploads (ADR-017 §4.4)
--
-- A staging allowance reserves quota BEFORE any file bytes are accepted.
-- This closes the accounting gap where streaming before reservation allowed
-- unaccounted disk usage.
--
-- Lifecycle (rev 24):
--   'active'    → created, file may be streaming. COUNTED in quota.
--   'expiring'  → expires_at passed, cleanup deferred (writer holds lock). COUNTED.
--   'expired'   → file deleted by cleanup. NOT counted. Terminal.
--   'cancelled' → converted to reservation or user-cancelled. NOT counted. Terminal.
--
-- There is no 'converting' state (removed in rev 8). Conversion goes directly
-- from 'active'/'expiring' to 'cancelled' in a single transaction.

CREATE TABLE IF NOT EXISTS staging_allowances (
  allowance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  max_bytes BIGINT NOT NULL CHECK (max_bytes > 0 AND max_bytes <= 10485760),
  state TEXT NOT NULL
    CHECK (state IN ('active', 'expiring', 'expired', 'cancelled'))
    DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set during conversion: links the allowance to its reservation for
  -- the orphan sweep and fence in-flight conversion detection.
  reservation_id UUID REFERENCES storage_reservations(reservation_id)
);

-- Index for quota calculation: find active/expiring allowances per world.
CREATE INDEX IF NOT EXISTS idx_staging_allowances_world_state
  ON staging_allowances(world_id, state) WHERE state IN ('active', 'expiring');

-- Index for expiry detection: find allowances past their expiry.
CREATE INDEX IF NOT EXISTS idx_staging_allowances_expiry
  ON staging_allowances(expires_at) WHERE state = 'active';

-- Index for orphan sweep: find cancelled allowances by reservation.
CREATE INDEX IF NOT EXISTS idx_staging_allowances_reservation
  ON staging_allowances(reservation_id) WHERE reservation_id IS NOT NULL;
