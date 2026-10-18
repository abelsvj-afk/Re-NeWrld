-- Migration 016: RES-1b Phase-2 writer obligations (ADR-017)
--
-- Adds the schema for crash-safe publication and stale temp cleanup:
--   world_media_assets new columns:
--     publication_status          — PENDING/ACTIVE/PUBLICATION_FAILED/PUBLICATION_IDENTITY_UNVERIFIED (§1.6)
--     content_sha256              — SHA-256 of published bytes, for EEXIST identity verification (§1.6b)
--     reservation_id              — links asset to its storage reservation (cleanup discovery, §1.6e)
--     temp_cleanup_fsync_pending  — write-ahead marker for stale temp cleanup (§1.6e, rev 14)
--     temp_cleanup_fsync_attempts — consecutive fsync failures (§1.6e, rev 16)
--     temp_cleanup_unlink_attempts— consecutive unlink failures (§1.6e, rev 16)
--     temp_cleanup_last_attempt_at— last cleanup attempt timestamp
--   temp_cleanup_incidents        — alert incident lifecycle per (reservation_id, failure_type) (§1.6e, rev 21-23)
--   temp_cleanup_delivery_outbox  — durable delivery events, separates incident from notification (§1.6e, rev 25-26)
--
-- ADR baseline: ADR-017-res-1b-design.md rev 30 (approved 2026-10-18).
-- Compatibility: up-only, idempotent re-runs. All columns/tables are NEW;
-- zero changes to existing columns/data. Uses IF NOT EXISTS and DO-block guards
-- (repo convention from 002, 014, 015). Depends on 015 (world_media_assets,
-- storage_reservations).

-- ---------------------------------------------------------------------------
-- 1. world_media_assets — new columns for publication and cleanup
-- ---------------------------------------------------------------------------

-- Publication status: tracks the crash-safe publication protocol (§1.6).
-- PENDING = DB committed, filesystem publication in progress or pending.
-- ACTIVE = fully published and verified.
-- PUBLICATION_FAILED = terminal failure (e.g., collision, link failed with no recovery).
-- PUBLICATION_IDENTITY_UNVERIFIED = EEXIST with unprovable identity; fail closed.
ALTER TABLE world_media_assets
  ADD COLUMN IF NOT EXISTS publication_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (publication_status IN ('PENDING','ACTIVE','PUBLICATION_FAILED','PUBLICATION_IDENTITY_UNVERIFIED'));

-- Content digest for EEXIST identity verification (§1.6b).
-- Written during Phase A; compared against final_path bytes on EEXIST.
ALTER TABLE world_media_assets
  ADD COLUMN IF NOT EXISTS content_sha256 CHAR(64);

-- Reservation link for stale temp cleanup discovery (§1.6e).
-- NULL for pre-RES-1b assets (backfilled or legacy); NOT NULL for new uploads.
ALTER TABLE world_media_assets
  ADD COLUMN IF NOT EXISTS reservation_id UUID REFERENCES storage_reservations(reservation_id);

-- Write-ahead marker for stale temp cleanup (§1.6e, rev 14).
-- Set TRUE before unlink; cleared only after fsync succeeds.
-- Rev 19: marker write NEVER modifies the failure counters.
ALTER TABLE world_media_assets
  ADD COLUMN IF NOT EXISTS temp_cleanup_fsync_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- Consecutive fsync(temp_dir) failures (§1.6e, rev 16).
-- Increments ONLY on fsync error. Reset to 0 on successful fsync.
ALTER TABLE world_media_assets
  ADD COLUMN IF NOT EXISTS temp_cleanup_fsync_attempts INT NOT NULL DEFAULT 0
    CHECK (temp_cleanup_fsync_attempts >= 0);

-- Consecutive unlink(temp_path) failures (§1.6e, rev 16).
-- Increments ONLY on unlink error (not ENOENT). Reset to 0 on successful unlink or observed ENOENT.
ALTER TABLE world_media_assets
  ADD COLUMN IF NOT EXISTS temp_cleanup_unlink_attempts INT NOT NULL DEFAULT 0
    CHECK (temp_cleanup_unlink_attempts >= 0);

-- Last cleanup attempt timestamp (for observability).
ALTER TABLE world_media_assets
  ADD COLUMN IF NOT EXISTS temp_cleanup_last_attempt_at TIMESTAMPTZ;

-- Index for stale cleanup discovery: find ACTIVE assets by reservation.
CREATE INDEX IF NOT EXISTS idx_world_media_assets_reservation_id
  ON world_media_assets (reservation_id) WHERE reservation_id IS NOT NULL;

-- Index for pending cleanup markers: find assets needing fsync retry.
CREATE INDEX IF NOT EXISTS idx_world_media_assets_cleanup_pending
  ON world_media_assets (temp_cleanup_fsync_pending)
  WHERE temp_cleanup_fsync_pending = TRUE;

-- ---------------------------------------------------------------------------
-- 2. temp_cleanup_incidents — alert incident lifecycle (rev 21-23)
-- ---------------------------------------------------------------------------
-- Each incident is uniquely identified by (reservation_id, failure_type).
-- Lifecycle: open → escalated → resolved. Recurrence creates a new incident
-- with a new UUID; resolved rows are retained for audit.

CREATE TABLE IF NOT EXISTS temp_cleanup_incidents (
  incident_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES storage_reservations(reservation_id),
  failure_type TEXT NOT NULL CHECK (failure_type IN ('unlink','fsync')),
  status TEXT NOT NULL CHECK (status IN ('open','escalated','resolved')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fired_count INT NOT NULL CHECK (last_fired_count > 0),
  acknowledged_at TIMESTAMPTZ
  -- No UNIQUE on (reservation_id, failure_type, status): multiple resolved
  -- incidents must coexist for audit. Uniqueness enforced by partial index below.
);

-- Partial unique index: at most one open/escalated incident per (reservation, type).
-- Resolved incidents are excluded, allowing unlimited audit history (rev 23).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'temp_cleanup_incidents_open_unique'
  ) THEN
    CREATE UNIQUE INDEX temp_cleanup_incidents_open_unique
      ON temp_cleanup_incidents (reservation_id, failure_type)
      WHERE status IN ('open', 'escalated');
  END IF;
END $$;

-- Index for startup reconciliation: find open/escalated incidents.
CREATE INDEX IF NOT EXISTS idx_temp_cleanup_incidents_open
  ON temp_cleanup_incidents (reservation_id, failure_type)
  WHERE status IN ('open', 'escalated');

-- ---------------------------------------------------------------------------
-- 3. temp_cleanup_delivery_outbox — durable delivery events (rev 25-26)
-- ---------------------------------------------------------------------------
-- Separates incident identity (incident_id) from notification-event identity
-- (delivery_event_id). Each firing creates a new event; the receiver
-- deduplicates on delivery_event_id, not incident_id.

CREATE TABLE IF NOT EXISTS temp_cleanup_delivery_outbox (
  delivery_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES temp_cleanup_incidents(incident_id),
  reservation_id UUID NOT NULL REFERENCES storage_reservations(reservation_id),
  failure_type TEXT NOT NULL CHECK (failure_type IN ('unlink','fsync')),
  fire_count INT NOT NULL CHECK (fire_count > 0),
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  claim_token UUID,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One delivery event per firing (rev 25).
  UNIQUE (incident_id, fire_count)
);

-- Index for delivery worker: find pending events eligible for retry.
CREATE INDEX IF NOT EXISTS idx_temp_cleanup_outbox_pending
  ON temp_cleanup_delivery_outbox (status, next_attempt_at)
  WHERE status = 'pending';

-- Index for incident correlation.
CREATE INDEX IF NOT EXISTS idx_temp_cleanup_outbox_incident
  ON temp_cleanup_delivery_outbox (incident_id);
