-- Migration 012: session checkpoints (Interactive Narrative Engine, Item D)
--
-- Automatic checkpoints at chapter boundaries allow readers to rewind
-- to earlier chapters without losing their original path.
--
-- Columns:
--   checkpoint_id PK, UUID
--   session_id    FK to reader_sessions
--   chapter_id    UUID of the chapter (may reference chapters table)
--   chapter_title Denormalized chapter title for display
--   scene_id      Scene the reader was at when checkpoint was created
--   state_variables JSONB snapshot of session state at checkpoint time
--   version       Session version at checkpoint time
--   created_at
--
-- Checkpoints are immutable once created. Rewinding creates a new
-- session version; the original path is preserved in the timeline.
--
-- Compatibility: up-only, filename-ordered with 001-011.

CREATE TABLE session_checkpoints (
  checkpoint_id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES reader_sessions(session_id) ON DELETE CASCADE,
  chapter_id UUID,
  chapter_title TEXT NOT NULL,
  scene_id UUID NOT NULL,
  state_variables JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_session_checkpoints_session ON session_checkpoints(session_id, created_at ASC);
