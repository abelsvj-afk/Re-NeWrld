-- Migration 010: choice visibility policy (Interactive Narrative Engine, Item C)
--
-- Adds per-choice visibility policy controlling how choices with unmet
-- conditions appear to readers:
--   'hide'        — choice invisible when conditions unmet (default, current behavior)
--   'show_locked' — choice rendered disabled with requirement cue (🔒 Requires ...)
--
-- Default is 'hide' preserving existing behavior. No backfill needed;
-- existing choices get the default automatically.
--
-- Compatibility: up-only, filename-ordered with 001-009. Applies cleanly to
-- a fresh database and takes effect immediately on existing databases.

ALTER TABLE choices ADD COLUMN visibility TEXT NOT NULL DEFAULT 'hide'
  CHECK (visibility IN ('hide', 'show_locked'));
