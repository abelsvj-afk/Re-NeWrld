-- ADR-017 SHARE-1: Snapshot reference tracking
-- Populated at publish time; protects assets from deletion while referenced by snapshots.

CREATE TABLE IF NOT EXISTS asset_snapshot_references (
  snapshot_id UUID NOT NULL,
  asset_id UUID NOT NULL REFERENCES world_media_assets(asset_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('cover', 'illustration')),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (snapshot_id, asset_id, role)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_refs_asset ON asset_snapshot_references(asset_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_refs_snapshot ON asset_snapshot_references(snapshot_id);
