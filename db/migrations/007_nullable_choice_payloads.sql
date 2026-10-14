-- Migration 007: nullable choice conditions/mutations (ADR-015 G1c, Task G1c)
--
-- The '{}'::jsonb column defaults made "absent" unrepresentable: every
-- choice inserted without explicit conditions/mutations got '{}', which G1c
-- (correctly, per ADR-015 §2) rejects as a publish blocker for newly
-- published canon. Absent conditions mean "unconditional" and absent
-- mutations mean "[]", so the columns must be nullable with no default.
--
-- Existing '{}' rows are LEFT UNTOUCHED. They were written under the old
-- system where '{}' meant "no conditions"; silently converting them to NULL
-- would rewrite history. They remain publish-blockers until the author
-- explicitly clears them — the ADR-015 policy (fail loud, not silent
-- reinterpretation). Already-published snapshots are unaffected (canon is
-- immutable; runtime grandfathers legacy '{}' as unconditional).
--
-- Compatibility: up-only, filename-ordered with 001-006. Applies cleanly to
-- a fresh database and takes effect immediately on existing databases.
-- No backfill; no data migration.

ALTER TABLE choices ALTER COLUMN conditions DROP DEFAULT;
ALTER TABLE choices ALTER COLUMN conditions DROP NOT NULL;
ALTER TABLE choices ALTER COLUMN mutations DROP DEFAULT;
ALTER TABLE choices ALTER COLUMN mutations DROP NOT NULL;
