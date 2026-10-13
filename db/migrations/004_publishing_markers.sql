-- Migration 004: publishing markers (ADR-013, Task E0)
--
-- Adds worlds.start_scene_id designating the world's entry point for
-- publishing graph traversal (nullable until set; publishing requires it).
--
-- The same-world composite foreign key (start_scene_id, world_id)
-- REFERENCES scenes(scene_id, world_id) reuses the existing
-- unique_scene_per_world constraint and follows the fk_choice_target_scene
-- pattern: a start scene must belong to the same world. A plain FK to
-- scenes(scene_id) would permit pointing at another world's scene.
--
-- NOTE: scenes.is_ending already exists in migration 001. It is
-- intentionally NOT re-added here — attempting to do so would fail
-- the migration with a duplicate-column error.
ALTER TABLE worlds
  ADD COLUMN start_scene_id UUID;

ALTER TABLE worlds
  ADD CONSTRAINT fk_world_start_scene
  FOREIGN KEY (start_scene_id, world_id)
  REFERENCES scenes(scene_id, world_id)
  ON DELETE RESTRICT;
