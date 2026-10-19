-- QUOTA-1: Authoritative quota function (ADR-017 §5.1)
--
-- There is exactly one definition, used by every path (upload check,
-- delete, reconciliation, error responses). Counts BOTH committed
-- registry usage AND outstanding reservations.

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
    ), 0);
$$ LANGUAGE SQL STABLE;
