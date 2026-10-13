import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/shared/database/db.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/shared/database/db.js';
import { PostgresWorldRepository } from '../../src/modules/world/infrastructure/persistence/postgres-world.repository.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { Scene } from '../../src/modules/world/domain/entities/scene.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { ChapterId } from '../../src/modules/world/domain/value-objects/chapter-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';

const mockedQuery = vi.mocked(query);

const validUuid1 = '123e4567-e89b-42d3-a456-426614174000';
const validUuid2 = '987fcdeb-5022-42d3-a456-426614174001';
const validUuid3 = '11111111-2222-4233-8444-555555555555';
const validUuid4 = '22222222-3333-4444-8555-666666666666';

function makeWorld(): World {
  return World.create({
    worldId: new WorldId(validUuid1),
    creatorId: new UserId(validUuid2),
    title: 'Test World',
  });
}

describe('E0: publishing markers', () => {
  describe('World entity startSceneId', () => {
    it('defaults to null when not provided', () => {
      expect(makeWorld().getStartSceneId()).toBeNull();
    });

    it('round-trips setStartSceneId / getStartSceneId and bumps updatedAt', () => {
      const world = makeWorld();
      const priorUpdatedAt = world.getUpdatedAt().getTime();
      const sceneId = new SceneId(validUuid3);

      world.setStartSceneId(sceneId);

      expect(world.getStartSceneId()).not.toBeNull();
      expect(world.getStartSceneId()!.equals(sceneId)).toBe(true);
      expect(world.getUpdatedAt().getTime()).toBeGreaterThanOrEqual(priorUpdatedAt);
    });

    it('can be cleared back to null', () => {
      const world = makeWorld();
      world.setStartSceneId(new SceneId(validUuid3));
      world.setStartSceneId(null);
      expect(world.getStartSceneId()).toBeNull();
    });

    it('accepts startSceneId via create props', () => {
      const sceneId = new SceneId(validUuid4);
      const world = World.create({
        worldId: new WorldId(validUuid1),
        creatorId: new UserId(validUuid2),
        title: 'Test World',
        startSceneId: sceneId,
      });
      expect(world.getStartSceneId()!.equals(sceneId)).toBe(true);
    });
  });

  describe('Scene entity isEnding (existing column wired through entity)', () => {
    it('defaults to false and can be set', () => {
      const scene = Scene.create({
        sceneId: new SceneId(validUuid3),
        worldId: new WorldId(validUuid1),
        chapterId: new ChapterId(validUuid2),
        title: 'Crossroads',
        prose: 'Two paths diverge.',
      });
      expect(scene.getIsEnding()).toBe(false);
      scene.setIsEnding(true);
      expect(scene.getIsEnding()).toBe(true);
    });
  });

  describe('PostgresWorldRepository start_scene_id mapping', () => {
    let repository: PostgresWorldRepository;

    beforeEach(() => {
      vi.resetAllMocks();
      repository = new PostgresWorldRepository();
    });

    it('save() persists start_scene_id and upserts it on conflict', async () => {
      const world = makeWorld();
      world.setStartSceneId(new SceneId(validUuid3));
      mockedQuery.mockResolvedValue({ rowCount: 1, rows: [] } as any);

      await repository.save(world);

      expect(mockedQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockedQuery.mock.calls[0];
      expect(sql).toContain('start_scene_id');
      expect(params).toContain(validUuid3);
      expect(sql).toContain('start_scene_id = EXCLUDED.start_scene_id');
    });

    it('save() persists NULL start_scene_id when unset', async () => {
      const world = makeWorld();
      mockedQuery.mockResolvedValue({ rowCount: 1, rows: [] } as any);

      await repository.save(world);

      const [, params] = mockedQuery.mock.calls[0];
      expect(params).toContain(null);
    });

    it('findById() maps start_scene_id row back to a SceneId', async () => {
      mockedQuery.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            world_id: validUuid1,
            creator_id: validUuid2,
            title: 'Test World',
            description: null,
            metadata: {},
            status: 'draft',
            start_scene_id: validUuid3,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      } as any);

      const world = await repository.findById(new WorldId(validUuid1));

      expect(world).not.toBeNull();
      expect(world!.getStartSceneId()).not.toBeNull();
      expect(world!.getStartSceneId()!.getValue()).toBe(validUuid3);
    });

    it('findById() maps NULL start_scene_id to null', async () => {
      mockedQuery.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            world_id: validUuid1,
            creator_id: validUuid2,
            title: 'Test World',
            description: null,
            metadata: {},
            status: 'draft',
            start_scene_id: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      } as any);

      const world = await repository.findById(new WorldId(validUuid1));

      expect(world).not.toBeNull();
      expect(world!.getStartSceneId()).toBeNull();
    });
  });

  describe('Migration 004 file guards', () => {
    const __filename = fileURLToPath(import.meta.url);
    const migrationPath = path.resolve(
      path.dirname(__filename),
      '../../db/migrations/004_publishing_markers.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    it('adds worlds.start_scene_id', () => {
      expect(sql).toMatch(/ALTER TABLE worlds[\s\S]*ADD COLUMN start_scene_id UUID/i);
    });

    it('enforces same-world ownership via composite FK to scenes(scene_id, world_id)', () => {
      expect(sql).toMatch(
        /FOREIGN KEY\s*\(\s*start_scene_id\s*,\s*world_id\s*\)\s*REFERENCES\s*scenes\s*\(\s*scene_id\s*,\s*world_id\s*\)/i
      );
    });

    it('does NOT re-add scenes.is_ending (column already exists in migration 001)', () => {
      expect(sql).not.toMatch(/ADD COLUMN\s+is_ending/i);
    });

    it('does not create any other schema objects', () => {
      expect(sql).not.toMatch(/CREATE TABLE/i);
    });
  });
});
