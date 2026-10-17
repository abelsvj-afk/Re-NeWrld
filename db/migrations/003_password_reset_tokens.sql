-- Migration 003: password_reset_tokens for self-serve account recovery (FR-13, ADR-012)
--
-- Stores only the SHA-256 hash of the reset token (same at-rest pattern as
-- auth_sessions in migration 002). The raw token is delivered to the user by
-- email and never persisted or logged. Tokens are single-use (used_at) with a
-- short expiry; expired rows are purged by the janitor in server.ts.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_reset_token_hash_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);
