-- Migration 008: reader timeline immutability (STOP-4, ADR-014 §7 follow-up)
--
-- Defense in depth for reader timeline entries: a BEFORE UPDATE OR DELETE
-- row trigger rejects every mutation of reader_timelines, while INSERTs
-- (the only legitimate write path, via the F2a/G2 choice transactions)
-- continue to work. The application layer is already append-only
-- (SessionRepositoryPort exposes no update/delete); this trigger makes the
-- guarantee hold even for direct SQL.
--
-- ADR-014 §7 deferred this as "code convention in this slice (no trigger)".
-- Phase G is the first phase to write timelines via the choice submission
-- path, so the deferral is formally expired. This migration closes H6.
--
-- Error contract: rejected statements raise SQLSTATE P0001 (raise_exception)
-- with a diagnostic message naming the operation (UPDATE/DELETE) and the
-- session_id + sequence_number. Callers should assert the SQLSTATE and a
-- stable message fragment, not the entire message.
--
-- Boundaries (deliberate, documented):
--   * TRUNCATE is NOT intercepted: row triggers do not fire on TRUNCATE.
--   * This guard protects against accidental application-level mutation. It is
--     not a defense against privileged database users.
--   * DDL and future migrations are unaffected (DML row-level trigger only).
--
-- Compatibility: up-only, filename-ordered with 001-007. Applies cleanly to a
-- fresh database and takes effect immediately on existing databases with no
-- backfill.

CREATE OR REPLACE FUNCTION reject_timeline_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reader_timelines is immutable: % not allowed (session_id=%, sequence_number=%)',
    TG_OP, OLD.session_id, OLD.sequence_number
    USING ERRCODE = 'P0001';
  RETURN NULL; -- unreachable: the exception aborts the statement
END;
$$;

DROP TRIGGER IF EXISTS trg_reader_timelines_immutable ON reader_timelines;

CREATE TRIGGER trg_reader_timelines_immutable
  BEFORE UPDATE OR DELETE ON reader_timelines
  FOR EACH ROW
  EXECUTE FUNCTION reject_timeline_mutation();
