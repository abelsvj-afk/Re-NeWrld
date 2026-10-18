-- Migration 015: media registry tables (ADR-017)
--
-- Creates the asset registry and its supporting tables:
--   world_media_assets        — asset registry (one row per physical file, §4.1)
--   asset_snapshot_references — snapshot-reference protection rows, keyed on
--                               stable filename identity, no FKs by design (§4.1)
--   unattributed_media_files  — protected home for unmatchable/orphan files (§4.7)
--   world_deletion_jobs       — world-deletion job state machine (§4.9)
--   storage_reservations      — durable capacity reservations, state IS the
--                               accounting category (§5.5)
--
-- ADR baseline: ADR-017 rev 26 (approved 2026-10-18).
-- Compatibility: up-only, idempotent re-runs. All tables are NEW (greenfield);
-- zero changes to existing tables/columns/data. CREATE TABLE/INDEX use
-- IF NOT EXISTS; the trigger is dropped-then-created (no CREATE OR REPLACE
-- TRIGGER in PostgreSQL); the two UNIQUE constraints use DO-block guards on
-- pg_constraint (repo convention from 002). Depends on 014 (FKs into
-- backfill_runs). The runner applies files in version order inside one
-- transaction per file (S57 atomicity).

-- ---------------------------------------------------------------------------
-- 1. world_media_assets — asset registry (ADR §4.1, line 100)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_media_assets (
  asset_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,              -- storage filename ({uuid}.{ext})
  url           TEXT NOT NULL,              -- /media/{filename}
  mimetype      TEXT NOT NULL,              -- validated at upload
  size_bytes    BIGINT NOT NULL,
  -- One row per physical file. A file may serve multiple roles (e.g. the same
  -- image used as both cover art and a scene illustration). Roles are tracked
  -- as an array so the identity stays one-to-one with the file: deletion of
  -- one role's reference never orphans or double-frees the file. Quota counts
  -- the file exactly once regardless of role count.
  -- `roles` reflects the roles CURRENTLY held in DRAFT metadata. Upload creates
  -- the row with roles='{}' (holds nothing yet); the metadata-switch transaction
  -- assigns/removes roles (§4.2, §4.3a). Snapshot references are found by the
  -- scanner (§4.2), never tracked in `roles`. Empty array = no draft references;
  -- the file may still be protected by retained snapshots.
  roles         TEXT[] NOT NULL DEFAULT '{}'
                CHECK (roles <@ ARRAY['cover','illustration']),
  -- Uniqueness within the array is enforced by a trigger, not CHECK (rev 19 — B1):
  -- PostgreSQL forbids subqueries in CHECK constraints. The value domain
  -- (<@, an immutable built-in operator) stays in CHECK; intra-array uniqueness
  -- (which requires unnest + aggregation) moves to a BEFORE trigger. Both fire
  -- atomically in the inserting/updating transaction.
  -- Lifecycle state: active → pending_deletion → (row deleted)
  -- pending_deletion means: proven unreferenced, file removal in progress or failed
  lifecycle     TEXT NOT NULL DEFAULT 'active'
                CHECK (lifecycle IN ('active','pending_deletion')),
  -- Whether the file has been confirmed present on disk by the last reconciliation.
  -- Set true at upload; reconciliation may set false (triggers data-loss alert, §9.2).
  file_confirmed_present BOOLEAN NOT NULL DEFAULT true,
  -- Worlds (other than world_id) whose draft metadata also references this URL.
  -- Populated by backfill/re-verification when a URL is found in multiple worlds'
  -- drafts. The owner (world_id) is the lexicographically smallest world_id
  -- among referencing worlds (rev 14, §4.7c B4a). Empty array = not shared.
  shared_with_worlds UUID[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Which backfill run created this row (rev 19 — B4). NULL for all normal-path
  -- rows (uploads, attributions). Set ONLY by backfill classification inserts.
  -- Lets the completion gate prove set equality against the run's inventory.
  backfill_run_id UUID REFERENCES backfill_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_world_media_assets_world_id
  ON world_media_assets (world_id);
CREATE INDEX IF NOT EXISTS idx_world_media_assets_world_id_lifecycle
  ON world_media_assets (world_id, lifecycle);
CREATE INDEX IF NOT EXISTS idx_world_media_assets_backfill_run_id
  ON world_media_assets (backfill_run_id) WHERE backfill_run_id IS NOT NULL;

-- Intra-array uniqueness for `roles` (rev 19 — B1). Fires BEFORE the row is
-- written, in the same transaction — a duplicate aborts the INSERT/UPDATE,
-- never a partially written row.
CREATE OR REPLACE FUNCTION check_roles_unique() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM unnest(NEW.roles) AS r)
     <> (SELECT count(DISTINCT r) FROM unnest(NEW.roles) AS r) THEN
    RAISE EXCEPTION 'world_media_assets.roles contains duplicates: %', NEW.roles
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- PostgreSQL has no CREATE OR REPLACE TRIGGER: drop-then-create is the
-- idempotent pattern (safe: the function is OR REPLACE'd above, and the
-- trigger is re-created in the same transaction).
DROP TRIGGER IF EXISTS trg_world_media_assets_roles_unique ON world_media_assets;
CREATE TRIGGER trg_world_media_assets_roles_unique
  BEFORE INSERT OR UPDATE OF roles ON world_media_assets
  FOR EACH ROW EXECUTE FUNCTION check_roles_unique();

-- Identity constraints (ADR §4.1): the registry relies on URL-to-row resolution
-- for deletion blocking and serving. Random UUID filenames make collisions
-- astronomically unlikely, but the database must enforce identity, not probability.
-- Duplicate filename → 500 (UUID-RNG failure or bug); duplicate url → 409 ASSET_URL_EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.conname = 'uq_world_media_assets_filename'
      AND t.relname = 'world_media_assets'
  ) THEN
    ALTER TABLE world_media_assets ADD CONSTRAINT uq_world_media_assets_filename UNIQUE (filename);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.conname = 'uq_world_media_assets_url'
      AND t.relname = 'world_media_assets'
  ) THEN
    ALTER TABLE world_media_assets ADD CONSTRAINT uq_world_media_assets_url UNIQUE (url);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. asset_snapshot_references — snapshot-reference protection (ADR §4.1, line 196)
--    Keyed on stable filename identity; deliberately NO FKs (rev 16 — B4.2):
--    CASCADE would delete protection rows on registry transfer; RESTRICT would
--    block the §4.9 T1 transfer. Blocking (F1), same-transaction cleanup (F2),
--    and drift audit (F3) replace cascade semantics.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_snapshot_references (
  filename    TEXT NOT NULL,  -- STABLE FILE IDENTITY: storage filename ({uuid}.{ext}).
  snapshot_id UUID NOT NULL,  -- references canon_snapshots(snapshot_id). No DB-level FK:
                             -- snapshot rows outlive world rows (retention, §5.4).
  world_id    UUID,  -- the world that owns the snapshot (denormalized for the scanner).
                   -- NULLABLE (rev 19 — B5): orphan snapshots (world_id NULL in
                   -- canon_snapshots, or world row gone) still get protection rows.
                   -- Protection is filename-keyed and never depends on world_id.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (filename, snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_snapshot_references_snapshot_id
  ON asset_snapshot_references (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_asset_snapshot_references_world_id
  ON asset_snapshot_references (world_id);

-- ---------------------------------------------------------------------------
-- 3. unattributed_media_files — protected home for orphans (ADR §4.7, line 1106)
--    Separate table because world_media_assets.world_id is NOT NULL — an
--    unmatchable file cannot satisfy the ownership constraint, and weakening it
--    would silently corrupt deletion and reference-scan behavior.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unattributed_media_files (
  file_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename           TEXT NOT NULL UNIQUE,   -- storage filename ({uuid}.{ext})
  url                TEXT NOT NULL,          -- /media/{filename}
  size_bytes         BIGINT,
  discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  matched_world_id   UUID REFERENCES worlds(world_id),  -- NULL until attributed
  referencing_worlds UUID[] NOT NULL DEFAULT '{}',      -- worlds whose drafts/snapshots contain this URL
  protected          BOOLEAN NOT NULL DEFAULT true,      -- true = deletion endpoint refuses
  -- Enforcement-gate status: every discovered file must reach a terminal state
  -- before lifecycle enforcement is enabled.
  classification_status TEXT NOT NULL DEFAULT 'pending_review'
                         CHECK (classification_status IN ('pending_review','reviewed','classified')),
  notes              TEXT,
  -- Which backfill run created this row (rev 19 — B4). NULL for rows created
  -- outside backfill (should not occur in practice; backfill owns this table).
  backfill_run_id UUID REFERENCES backfill_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_unattributed_media_files_backfill_run_id
  ON unattributed_media_files (backfill_run_id) WHERE backfill_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. world_deletion_jobs — world-deletion job state machine (ADR §4.9, line 1602)
--    Terminal condition is "job row absent" (T5 deletes the world row; the job
--    cascades). `complete` is NOT a persisted state (rev 9).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_deletion_jobs (
  job_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'assets_pending'
                  CHECK (state IN ('assets_pending','files_removing','rows_removing')),
  files_total   INT NOT NULL DEFAULT 0,
  files_removed INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (world_id)   -- one job per world
);

-- ---------------------------------------------------------------------------
-- 5. storage_reservations — durable capacity reservations (ADR §5.5, line 1865)
--    The state column ALONE determines the accounting category (rev 15 — B1.1);
--    the CHECKs below make released_at a provable function of state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id       UUID NOT NULL,
  size_bytes     BIGINT NOT NULL,
  temp_filename  TEXT,  -- audit only (rev 14); safety decisions use the deterministic path
  state          TEXT NOT NULL DEFAULT 'RESERVED'
                   CHECK (state IN ('RESERVED','WRITING','ABANDONED','COMMITTED','ROLLED_BACK','CLEANED')),
                 -- DURABLE accounting category (rev 15 — B1.1). The capacity query derives
                 -- categories SOLELY from this column. No filesystem scan is load-bearing
                 -- for the accounting handoff.
  epoch          BIGINT NOT NULL DEFAULT 0,
                 -- heartbeat generation counter (rev 15 — B1.2). Incremented on every
                 -- heartbeat. Expiry claims use compare-and-swap on epoch.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes',
  released_at    TIMESTAMPTZ,  -- set when the reservation leaves active accounting
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_epoch    BIGINT,       -- epoch observed when the expiry claim finalized (audit)
  claim_finalized_at TIMESTAMPTZ,  -- when state transitioned to ABANDONED via expiry (audit)
  -- State/timestamp consistency (rev 16 — B1.1): the state column ALONE determines
  -- the accounting category. These constraints make released_at a provable function
  -- of state — no row can exist in a combination that would silently omit or
  -- double-count bytes.
  CHECK (
    (state IN ('RESERVED','WRITING') AND released_at IS NULL)
    OR
    (state IN ('ABANDONED','COMMITTED','ROLLED_BACK','CLEANED') AND released_at IS NOT NULL)
  ),
  -- Claim audit columns are meaningful only for abandonments; they travel together.
  -- (rev 26-style explicitness: co-nullity in both directions — a non-ABANDONED
  -- row with claim columns set, or an ABANDONED row with only one set, is rejected.)
  CHECK (
    (claim_epoch IS NULL AND claim_finalized_at IS NULL)
    OR
    (claim_epoch IS NOT NULL AND claim_finalized_at IS NOT NULL AND state = 'ABANDONED')
  ),
  CHECK (size_bytes > 0),
  CHECK (epoch >= 0)
  -- A reservation is "active" iff state IN ('RESERVED','WRITING') — provably
  -- equivalent to released_at IS NULL by the first CHECK above.
  -- Crash safety: the row is durable (committed before any bytes are written).
);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_expires_at
  ON storage_reservations (expires_at) WHERE released_at IS NULL;
