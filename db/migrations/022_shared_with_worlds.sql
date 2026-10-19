-- ADR-017 SHARE-1: Cross-world asset sharing
-- shared_with_worlds: array of world IDs that can reference this asset.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'world_media_assets'
      AND column_name = 'shared_with_worlds'
  ) THEN
    ALTER TABLE public.world_media_assets
      ADD COLUMN shared_with_worlds UUID[] DEFAULT '{}' NOT NULL;
    RAISE NOTICE 'Added shared_with_worlds column';
  ELSE
    RAISE NOTICE 'shared_with_worlds already exists';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_assets_shared_worlds
  ON world_media_assets USING GIN (shared_with_worlds);
