-- UPLOAD-1: quota_used_bytes() counts staging allowances (ADR-017 §5.1, rev 24)
--
-- This replaces migration 017's definition. Active and expiring staging
-- allowances count at max_bytes. This ensures the 10 MB staging cap is
-- accounted from the moment the allowance is created (before any bytes stream).
--
-- State accounting:
--   'active', 'expiring' → COUNTED (file may exist on disk)
--   'expired', 'cancelled' → NOT counted (terminal: file deleted or converted)
--
-- Note: No expires_at check in the WHERE clause. The state machine is
-- authoritative. An 'expiring' allowance counts even after expires_at passes
-- (cleanup deferred because writer holds the file lock).

CREATE OR REPLACE FUNCTION quota_used_bytes(p_world_id UUID)
RETURNS BIGINT AS $$
  SELECT
    COALESCE((
      SELECT SUM(size_bytes) FROM world_media_assets
      WHERE world_id = p_world_id
        AND lifecycle IN ('active', 'pending_deletion')
        AND file_confirmed_present = true
    ), 0)
    +
    COALESCE((
      SELECT SUM(size_bytes) FROM storage_reservations
      WHERE world_id = p_world_id
        AND state IN ('RESERVED', 'WRITING')
    ), 0)
    +
    COALESCE((
      SELECT SUM(max_bytes) FROM staging_allowances
      WHERE world_id = p_world_id
        AND state IN ('active', 'expiring')
    ), 0);
$$ LANGUAGE SQL STABLE;
