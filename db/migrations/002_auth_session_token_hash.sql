-- Migration 002: Store SHA-256 hash of session tokens in auth_sessions
--
-- Non-destructive: existing sessions are preserved by hashing the old UUID
-- token in place (pgcrypto's digest(), enabled in 001). Clients presenting
-- their existing session cookie keep working, because the application hashes
-- the presented token with SHA-256 hex — identical to
-- encode(digest(<uuid::text>, 'sha256'), 'hex') computed here.
-- Previously this migration ran DELETE FROM auth_sessions, irreversibly
-- logging out every user. Never destroy user data in a migration.
ALTER TABLE auth_sessions RENAME COLUMN session_id TO token_hash;
ALTER TABLE auth_sessions ALTER COLUMN token_hash DROP DEFAULT;
ALTER TABLE auth_sessions ALTER COLUMN token_hash TYPE VARCHAR(64)
  USING encode(digest(token_hash::text, 'sha256'), 'hex');
ALTER TABLE auth_sessions ADD CONSTRAINT chk_token_hash_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$');
