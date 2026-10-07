-- Migration 001: Initial MVP Schema (B2 Design Contract - Refined Choice Integrity)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK (role IN ('creator', 'reader')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS worlds (
  world_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS characters (
  character_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  role_types JSONB NOT NULL DEFAULT '[]',
  description TEXT,
  attributes JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chapters (
  chapter_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_chapter_per_world UNIQUE (chapter_id, world_id)
);

CREATE TABLE IF NOT EXISTS scenes (
  scene_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  chapter_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  prose TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  is_ending BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_scene_chapter FOREIGN KEY (chapter_id, world_id) REFERENCES chapters(chapter_id, world_id) ON DELETE CASCADE,
  CONSTRAINT unique_scene_per_world UNIQUE (scene_id, world_id)
);

CREATE TABLE IF NOT EXISTS choices (
  choice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  scene_id UUID NOT NULL,
  target_scene_id UUID NOT NULL,
  text TEXT NOT NULL,
  conditions JSONB NOT NULL DEFAULT '{}',
  mutations JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_choice_scene FOREIGN KEY (scene_id, world_id) REFERENCES scenes(scene_id, world_id) ON DELETE CASCADE,
  CONSTRAINT fk_choice_target_scene FOREIGN KEY (target_scene_id, world_id) REFERENCES scenes(scene_id, world_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS published_canon_snapshots (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  canon_data JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_version_per_world UNIQUE (world_id, version_number),
  CONSTRAINT unique_snapshot_world UNIQUE (snapshot_id, world_id)
);

CREATE TABLE IF NOT EXISTS reader_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_id UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  world_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  current_scene_id UUID NOT NULL,
  state_variables JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_session_snapshot FOREIGN KEY (snapshot_id, world_id) REFERENCES published_canon_snapshots(snapshot_id, world_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS reader_timelines (
  timeline_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES reader_sessions(session_id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  from_scene_id UUID NOT NULL,
  to_scene_id UUID NOT NULL,
  choice_id UUID NOT NULL,
  state_diff JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_sequence_per_session UNIQUE (session_id, sequence_number)
);

-- Indexes for known MVP access patterns
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_characters_world_id ON characters(world_id);
CREATE INDEX IF NOT EXISTS idx_chapters_world_id ON chapters(world_id);
CREATE INDEX IF NOT EXISTS idx_scenes_world_id ON scenes(world_id);
CREATE INDEX IF NOT EXISTS idx_scenes_chapter_id ON scenes(chapter_id);
CREATE INDEX IF NOT EXISTS idx_choices_world_id ON choices(world_id);
CREATE INDEX IF NOT EXISTS idx_choices_scene_id ON choices(scene_id);
CREATE INDEX IF NOT EXISTS idx_choices_target_scene_id ON choices(target_scene_id);
CREATE INDEX IF NOT EXISTS idx_published_canon_snapshots_world_id ON published_canon_snapshots(world_id);
CREATE INDEX IF NOT EXISTS idx_reader_sessions_reader_id ON reader_sessions(reader_id);
CREATE INDEX IF NOT EXISTS idx_reader_sessions_world_id ON reader_sessions(world_id);
CREATE INDEX IF NOT EXISTS idx_reader_sessions_snapshot_id ON reader_sessions(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_reader_timelines_session_id ON reader_timelines(session_id);

-- GIN indexes for JSONB payloads
CREATE INDEX IF NOT EXISTS idx_choices_conditions_gin ON choices USING GIN (conditions);
CREATE INDEX IF NOT EXISTS idx_choices_mutations_gin ON choices USING GIN (mutations);
CREATE INDEX IF NOT EXISTS idx_characters_attributes_gin ON characters USING GIN (attributes);
CREATE INDEX IF NOT EXISTS idx_characters_role_types_gin ON characters USING GIN (role_types);
CREATE INDEX IF NOT EXISTS idx_reader_sessions_state_vars_gin ON reader_sessions USING GIN (state_variables);
