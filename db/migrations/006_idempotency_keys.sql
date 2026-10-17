-- Migration 006: idempotency keys for choice submission (ADR-015 D3, Task G2a)
--
-- Exactly-once semantics for POST /sessions/:id/choices. Keys are GLOBALLY
-- unique (PRIMARY KEY on idempotency_key); what is session-bound is the
-- REPLAY, not the key namespace: a stored key replays its response only for
-- its original session + request fingerprint. The same key presented with a
-- different session or fingerprint yields 409, never a replay and never an
-- overwrite (the PK constraint plus the D3a recovery algorithm enforce this).
--
-- request_hash: lowercase hex SHA-256 over the canonical payload bytes
--   {"choiceId":"<lowercase-uuid>","expectedVersion":<int>,"sessionId":"<lowercase-uuid>"}
--   (UTF-8, no whitespace, fixed key order — ADR-015 D3 step 2, B35).
--
-- response: the constructed success response, stored as JSONB at commit time
--   (same transaction as the session UPDATE + timeline INSERT — ADR-015 D3
--   step 16). Replays re-serialize this data; the contract guarantees
--   identical response DATA (deep-equal), not byte-for-byte HTTP replay.
--
-- expires_at: 24h retention (ADR-013 D3). A record is expired <=> 
--   expires_at <= now(), evaluated in SQL on the database clock — never in
--   application code (ADR-015 B34). An expired record never blocks a
--   legitimate retry: the in-transaction recheck reclaims it, and the
--   periodic cleanup below is an optimization, not a correctness mechanism.
--
-- session_id ON DELETE CASCADE is defensive: no code path in src/ or
--   migrations/ deletes reader_sessions in the MVP (verified 2026-10-13),
--   so the cascade cannot fire today. If session deletion ever becomes
--   possible, the contract is: idempotency rows vanish with the session and
--   a retry proceeds as a new submission (404 at the session lookup).
--
-- Compatibility: up-only, filename-ordered with 001-005. Applies cleanly to
-- a fresh database and takes effect immediately on existing databases with
-- no backfill (the table starts empty).

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES reader_sessions(session_id) ON DELETE CASCADE,
  request_hash CHAR(64) NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
