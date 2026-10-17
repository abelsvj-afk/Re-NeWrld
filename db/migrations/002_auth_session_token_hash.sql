-- Migration 002: Store SHA-256 hash of session tokens in auth_sessions
--
-- Non-destructive: existing sessions are preserved by hashing the old UUID
-- token in place (pgcrypto's digest(), enabled in 001). Clients presenting
-- their existing session cookie keep working, because the application hashes
-- the presented token with SHA-256 hex — identical to
-- encode(digest(<uuid::text>, 'sha256'), 'hex') computed here.
-- Previously this migration ran DELETE FROM auth_sessions, irreversibly
-- logging out every user. Never destroy user data in a migration.
--
-- Defensive (2026-10-16): each step is guarded so this migration is safe to
-- (re-)run regardless of which prior partial state the table is in. In
-- particular, the RENAME is skipped when session_id is already gone, and the
-- hashing conversion is skipped when token_hash is already VARCHAR(64),
-- so existing hashes are never double-hashed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'auth_sessions'
      AND column_name = 'session_id'
  ) THEN
    ALTER TABLE auth_sessions RENAME COLUMN session_id TO token_hash;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'auth_sessions'
      AND column_name = 'token_hash' AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE auth_sessions ALTER COLUMN token_hash DROP DEFAULT;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'auth_sessions'
      AND column_name = 'token_hash' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE auth_sessions ALTER COLUMN token_hash TYPE VARCHAR(64)
      USING encode(digest(token_hash::text, 'sha256'), 'hex');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'auth_sessions'
      AND constraint_name = 'chk_token_hash_sha256'
  ) THEN
    ALTER TABLE auth_sessions ADD CONSTRAINT chk_token_hash_sha256
      CHECK (token_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;
