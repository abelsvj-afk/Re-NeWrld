-- Migration 014: media durable-operations machinery (ADR-017)
--
-- Creates the durable operations tables for the asset lifecycle system:
--   system_maintenance        — singleton maintenance fence (fail-closed contract, §4.3d)
--   recovery_authorizations   — durable recovery authorization + time-independent
--                               partial unique index (rev 20 — B1)
--   backfill_runs             — durable backfill run record, final form incl.
--                               attribution_input_hash (rev 13) and failure_reason (rev 19 — B4)
--   backfill_inventory_files  — durable per-file inventory manifest (rev 19 — B4)
--   backfill_conflicts        — conflict records incl. rev-25/26 drift-diagnostic
--                               columns + backfill_conflicts_drift_fields_ck
--
-- ADR baseline: ADR-017 rev 26 (approved 2026-10-18).
-- Compatibility: up-only, idempotent re-runs. All tables are NEW (greenfield);
-- zero changes to existing tables/columns/data. CREATE TABLE/INDEX use
-- IF NOT EXISTS; the singleton seed uses ON CONFLICT DO NOTHING.
-- pgcrypto (gen_random_uuid) was enabled in migration 001 — no new extension.

-- ---------------------------------------------------------------------------
-- 1. system_maintenance — durable maintenance fence (ADR §4.3d, line 703)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_maintenance (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  active       BOOLEAN NOT NULL DEFAULT false,
  reason       TEXT NOT NULL DEFAULT '',
  started_at   TIMESTAMPTZ,
  started_by   TEXT,  -- operator identity
  CONSTRAINT single_row CHECK (id = 1)
);
-- Exactly one row always exists. INSERTed at migration time; only UPDATEs thereafter.
INSERT INTO system_maintenance (id, active, reason) VALUES (1, false, '')
  ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. recovery_authorizations — durable recovery authorization (ADR §4.3d, line 832)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_authorizations (
  authorization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            TEXT NOT NULL CHECK (scope IN ('repair','restore-reconcile')),
  authorized_by    TEXT NOT NULL,  -- operator identity (auditable)
  authorized_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + interval '4 hours',
  revoked_at       TIMESTAMPTZ,    -- set on revocation; NULL = not revoked
  revoke_reason    TEXT CHECK (revoke_reason IN ('operator','expired','superseded'))
                   -- why the row left the unrevoked set (audit; NULL while unrevoked).
                   -- 'expired' is set by the establishment transaction's close-expired
                   -- step (rev 20 — B1); 'operator' by explicit revoke; 'superseded'
                   -- reserved for a future rotation protocol (unused in MVP).
);
-- At most one UNREVOKED authorization, by exclusion. The predicate MUST be
-- time-independent (rev 20 — B1): PostgreSQL requires index-predicate functions
-- to be immutable, and now() is not — the rev-19 predicate
-- WHERE revoked_at IS NULL AND expires_at > now() is REJECTED at CREATE INDEX
-- time. Expiry is enforced by the establishment transaction (close-expired step)
-- and by per-transaction revalidation — never by the index.
CREATE UNIQUE INDEX IF NOT EXISTS one_unrevoked_recovery_auth
  ON recovery_authorizations ((1))
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. backfill_runs — durable backfill run record (ADR §4.7, line 1175)
--    Created in final form: includes attribution_input_hash (rev 13) and
--    failure_reason (rev 19 — B4). The ADR's ALTER TABLE ... ADD COLUMN
--    attribution_input_hash / DROP COLUMN metadata_version_hash describe the
--    rev-12→13 design transition, not a migration against an existing table —
--    backfill_runs does not exist yet, so metadata_version_hash never exists.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backfill_runs (
  run_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state                   TEXT NOT NULL DEFAULT 'in_progress'
                            CHECK (state IN ('in_progress','complete','failed')),
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ,
  failure_reason          TEXT,           -- set when state transitions to 'failed' (rev 19 — B4)
  final_inventory_count   INT,            -- authoritative file count after write-freeze
  final_inventory_checksum TEXT,          -- SHA-256 of the inventory manifest itself
  files_classified        INT NOT NULL DEFAULT 0,
  files_pending           INT NOT NULL DEFAULT 0,
  attribution_input_hash  TEXT            -- rev 13: SHA-256 over the canonical JSON
                                         -- serialization of the classification inputs
);

-- Single active run (ADR §4.7b, line 1386, prose-specified): at most one
-- in_progress run exists. A second backfill start while one is active →
-- unique violation → 409 BACKFILL_ALREADY_RUNNING.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_backfill_run
  ON backfill_runs ((1))
  WHERE state = 'in_progress';

-- ---------------------------------------------------------------------------
-- 4. backfill_inventory_files — durable per-file inventory manifest (ADR §4.7, line 1191)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backfill_inventory_files (
  run_id     UUID NOT NULL REFERENCES backfill_runs(run_id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,  -- storage filename ({uuid}.{ext})
  size_bytes BIGINT,
  sha256     TEXT,           -- content hash at inventory time (may be NULL if unreadable)
  PRIMARY KEY (run_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_backfill_inventory_files_run_id
  ON backfill_inventory_files (run_id);

-- ---------------------------------------------------------------------------
-- 5. backfill_conflicts — conflict records (ADR §4.7, line 1258; rev 25/26)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backfill_conflicts (
  conflict_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID REFERENCES backfill_runs(run_id),
                        -- NULLABLE (rev 24 — B2): NULL = operator-originated drift
                        -- conflict recorded outside any run (e.g., a deletion-time
                        -- authoritative-verification discrepancy, §4.2 part 4).
  filename          TEXT NOT NULL,
  url               TEXT NOT NULL,
  existing_world_id UUID,               -- world_id on the current registry row (NULL if none)
  recomputed_world_id UUID,             -- world_id the new run's classification produced
  existing_roles    TEXT[],
  recomputed_roles  TEXT[],
  reason            TEXT NOT NULL,      -- e.g. 'world_id changed', 'roles stale', 'mimetype re-detected',
                                       -- 'world_mismatch', 'attributable', 'snapshot_ref_drift'
  subtype           TEXT,               -- rev 25: drift subtype — 'missing_row' | 'stale_row'.
                                       -- Set ONLY when reason='snapshot_ref_drift'; NULL otherwise
                                       -- (enforced by the CHECK below).
  expected_snapshot_ids UUID[],         -- rev 25: authoritative expected snapshot-id set
                                       -- (drift rows only; NULL otherwise).
  actual_snapshot_ids   UUID[],         -- rev 25: actual asset_snapshot_references snapshot-id
                                       -- set (drift rows only; NULL otherwise).
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,        -- set when the operator resolves
  resolution        TEXT,               -- 'accepted_recomputed' | 'kept_existing' | notes
  -- rev 25: drift rows carry their diagnostic sets; non-drift rows carry none.
  -- The CHECK is the enforcement — there is no silent ambiguity about which
  -- fields a given reason may populate. Empty arrays are legal for the sets
  -- (e.g. actual='{}' on a missing_row); only NULL is forbidden on drift rows.
  CONSTRAINT backfill_conflicts_drift_fields_ck CHECK (
    (reason = 'snapshot_ref_drift'
       -- rev 26: subtype IS NOT NULL is explicit because NULL IN (...)
       -- evaluates to NULL (not FALSE) under three-valued logic; without it,
       -- a drift row with subtype = NULL and both arrays populated yields
       -- NULL OR FALSE = NULL, which CHECK accepts.
       AND subtype IS NOT NULL
       AND subtype IN ('missing_row', 'stale_row')
       AND expected_snapshot_ids IS NOT NULL
       AND actual_snapshot_ids IS NOT NULL)
    OR
    (reason <> 'snapshot_ref_drift'
       AND subtype IS NULL
       AND expected_snapshot_ids IS NULL
       AND actual_snapshot_ids IS NULL)
  )
);
