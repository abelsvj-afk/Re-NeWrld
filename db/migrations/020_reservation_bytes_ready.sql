-- UPLOAD-1: bytes_ready flag on storage_reservations (ADR-017 §4.4, rev 24)
--
-- Prevents Phase-2 from consuming a reservation before the initial byte
-- transfer (staging → .part) is complete and durable.
--
-- Semantics:
--   false → initial transfer not complete. Phase-2 writers MUST refuse.
--   true  → bytes are on disk and fsync'd. Phase-2 may proceed.
--
-- For RES-1a direct reservations (no staging transfer): set true at creation.
-- For UPLOAD-1 conversions: set false at creation, true after transfer.

DO $$
DECLARE
  v_exists BOOLEAN;
  v_default TEXT;
  v_data_type TEXT;
  v_is_nullable TEXT;
BEGIN
  -- Use explicit 'public' schema for both inspection and modification.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'storage_reservations'
      AND column_name = 'bytes_ready'
  ) INTO v_exists;

  IF NOT v_exists THEN
    -- First run: add with DEFAULT true so existing direct-write rows are correct,
    -- then change default to false for future inserts (fail-closed).
    ALTER TABLE public.storage_reservations
      ADD COLUMN bytes_ready BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE public.storage_reservations
      ALTER COLUMN bytes_ready SET DEFAULT false;
    RAISE NOTICE 'Migration 020: column added, existing rows=true, default=false';

  ELSE
    -- Rerun: validate type/nullability, ensure default is false.
    SELECT column_default, data_type, is_nullable
    INTO v_default, v_data_type, v_is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'storage_reservations'
      AND column_name = 'bytes_ready';

    IF v_data_type != 'boolean' THEN
      RAISE EXCEPTION 'Migration 020: bytes_ready has wrong type % (expected boolean)', v_data_type;
    END IF;
    IF v_is_nullable != 'NO' THEN
      RAISE EXCEPTION 'Migration 020: bytes_ready must be NOT NULL';
    END IF;

    -- Accept only exact representations of boolean false.
    IF v_default IS NULL THEN
      ALTER TABLE public.storage_reservations
        ALTER COLUMN bytes_ready SET DEFAULT false;
      RAISE NOTICE 'Migration 020: default was NULL, corrected to false';
    ELSIF v_default IN ('false', 'false::boolean', '''false''::boolean') THEN
      RAISE NOTICE 'Migration 020: already applied, no changes needed';
    ELSE
      ALTER TABLE public.storage_reservations
        ALTER COLUMN bytes_ready SET DEFAULT false;
      RAISE NOTICE 'Migration 020: unrecognized default (%), corrected to false', v_default;
    END IF;
  END IF;
END $$;
