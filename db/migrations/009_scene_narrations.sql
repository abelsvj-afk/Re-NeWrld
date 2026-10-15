-- Migration 009: scene narrations (ADR-016, H-UI-tts)
--
-- Content-addressed permanent cache for ElevenLabs TTS audio.
-- Key: (world_id, canon_version, scene_id, prose_hash, voice_id, model_id)
-- Published canon is immutable, so published-version rows are permanent.
-- New versions produce new hashes; old rows serve in-progress readers.
--
-- Boundaries:
--   * Audio bytes live on the persistent volume (NARRATION_STORAGE_PATH),
--     this table holds metadata + the content hash for cache lookups.
--   * Draft (unpublished) rows are deleted when their scene/world is deleted.

CREATE TABLE IF NOT EXISTS scene_narrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  canon_version INTEGER NOT NULL DEFAULT 0,
  scene_id UUID NOT NULL REFERENCES scenes(scene_id) ON DELETE CASCADE,
  prose_hash CHAR(64) NOT NULL,
  voice_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(64) NOT NULL DEFAULT 'eleven_turbo_v2_5',
  audio_path VARCHAR(1024) NOT NULL,
  character_count INTEGER NOT NULL CHECK (character_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_narration_content UNIQUE (world_id, canon_version, scene_id, prose_hash, voice_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_narrations_lookup
  ON scene_narrations (world_id, scene_id, prose_hash);

CREATE INDEX IF NOT EXISTS idx_narrations_world
  ON scene_narrations (world_id);
