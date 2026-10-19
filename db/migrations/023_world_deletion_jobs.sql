-- ADR-017 DEL-2: World deletion job tracking
-- Tracks the 5-transaction deletion state machine for crash recovery.

CREATE TABLE IF NOT EXISTS world_deletion_jobs (
  job_id UUID PRIMARY KEY,
  world_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    't1_complete', 't2_complete', 't3_complete', 't4_complete', 'complete', 'failed'
  )),
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deletion_jobs_state ON world_deletion_jobs(state);
CREATE INDEX IF NOT EXISTS idx_deletion_jobs_world ON world_deletion_jobs(world_id);
