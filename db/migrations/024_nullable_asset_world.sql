-- ADR-017 DEL-2: Allow assets without an owning world
-- Required for T1 step 5: snapshot-protected assets transfer to "unattributed" state.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'world_media_assets'
      AND column_name = 'world_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.world_media_assets ALTER COLUMN world_id DROP NOT NULL;
    RAISE NOTICE 'Made world_media_assets.world_id nullable';
  ELSE
    RAISE NOTICE 'world_media_assets.world_id already nullable or missing';
  END IF;
END $$;
