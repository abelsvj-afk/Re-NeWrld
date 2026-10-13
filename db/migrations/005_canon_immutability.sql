-- Migration 005: canon snapshot immutability (ADR-013 D1, Task E2c)
--
-- Defense in depth for published canon snapshots: a BEFORE UPDATE OR DELETE
-- row trigger rejects every mutation of published_canon_snapshots, while
-- INSERTs (the only legitimate write path, via the E2a publish transaction)
-- continue to work. The application layer is already append-only
-- (CanonRepositoryPort exposes no update/delete); this trigger makes the
-- guarantee hold even for direct SQL.
--
-- Error contract: rejected statements raise SQLSTATE P0001 (raise_exception)
-- with a diagnostic message naming the operation (UPDATE/DELETE) and the
-- snapshot_id. Callers should assert the SQLSTATE and a stable message
-- fragment, not the entire message.
--
-- Boundaries (deliberate, documented):
--   * TRUNCATE is NOT intercepted: row triggers do not fire on TRUNCATE, and
--     this trigger must not be claimed to prevent it. The application role
--     genuinely lacks TRUNCATE privileges.
--   * This guard protects against accidental application-level mutation. It is
--     not a defense against privileged database users, who can alter triggers
--     or execute privileged operations.
--   * DDL and future migrations are unaffected (DML row-level trigger only).
--   * Retention / account-deletion design is explicitly deferred (ADR-013).
--
-- Compatibility: up-only, filename-ordered with 001-004. Applies cleanly to a
-- fresh database (001 owns the table) and takes effect immediately on existing
-- databases with no backfill. Removing the trigger later would itself be a
-- new migration.

CREATE OR REPLACE FUNCTION reject_canon_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'published_canon_snapshots is immutable: % not allowed (snapshot_id=%)',
    TG_OP, OLD.snapshot_id
    USING ERRCODE = 'P0001';
  RETURN NULL; -- unreachable: the exception aborts the statement
END;
$$;

DROP TRIGGER IF EXISTS trg_canon_snapshots_immutable ON published_canon_snapshots;

CREATE TRIGGER trg_canon_snapshots_immutable
  BEFORE UPDATE OR DELETE ON published_canon_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION reject_canon_snapshot_mutation();
