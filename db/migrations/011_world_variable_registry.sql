-- Migration 011: world variable registry (Interactive Narrative Engine, Item B)
--
-- Central registry of typed story variables per world. Prevents typos in
-- condition/mutation variable names, provides defaults for new sessions,
-- and enables human-readable labels in locked choice cues and inventory.
--
-- Columns:
--   variable_id   PK, UUID
--   world_id      FK to worlds
--   name          Variable name used in conditions (e.g. "trust_kael")
--                 Must be a valid identifier: [a-z][a-z0-9_]*
--   type          'boolean' | 'number' | 'string'
--   default_value JSONB, the initial value for new sessions (nullable = no default)
--   label         Human-readable display name (e.g. "Trust with Kael")
--   description   Author notes (optional)
--   category      'stat' | 'inventory' | 'relationship' | 'flag' | 'other'
--                 Used by the reader inventory drawer for grouping
--
-- Unique constraint on (world_id, name) — variable names are per-world unique.
--
-- Compatibility: up-only, filename-ordered with 001-010. Applies cleanly to
-- a fresh database and takes effect immediately on existing databases.

CREATE TABLE IF NOT EXISTS world_variables (
  variable_id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]*$'),
  type TEXT NOT NULL CHECK (type IN ('boolean', 'number', 'string')),
  default_value JSONB,
  label TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('stat', 'inventory', 'relationship', 'flag', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (world_id, name)
);

CREATE INDEX IF NOT EXISTS idx_world_variables_world ON world_variables(world_id);
