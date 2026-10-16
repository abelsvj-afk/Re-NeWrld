-- Migration 013: missing FK indexes (audit finding 2026-10-16)
--
-- Adds indexes on foreign keys that were missing, causing full table scans:
--   worlds.creator_id — used by findByCreatorId on creator dashboard
--   idempotency_keys.session_id — used on session deletes (CASCADE)
--
-- Compatibility: up-only, uses IF NOT EXISTS for safety.

CREATE INDEX IF NOT EXISTS idx_worlds_creator_id ON worlds(creator_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_session_id ON idempotency_keys(session_id);
