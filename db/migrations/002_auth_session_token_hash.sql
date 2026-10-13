-- Migration 002: Store SHA-256 hash of session tokens in auth_sessions
DELETE FROM auth_sessions;
ALTER TABLE auth_sessions RENAME COLUMN session_id TO token_hash;
ALTER TABLE auth_sessions ALTER COLUMN token_hash DROP DEFAULT;
ALTER TABLE auth_sessions ALTER COLUMN token_hash TYPE VARCHAR(64) USING token_hash::text;
ALTER TABLE auth_sessions ADD CONSTRAINT chk_token_hash_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$');
