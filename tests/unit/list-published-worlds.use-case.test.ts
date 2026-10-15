import { describe, it, expect, vi } from 'vitest';
import { ListPublishedWorldsUseCase } from '../../src/modules/world/application/list-published-worlds.use-case.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { WorldStatus } from '../../src/modules/world/domain/value-objects/world-status.value-object.js';
import crypto from 'node:crypto';

function makeWorld(overrides: { status?: string; metadata?: Record<string, unknown> } = {}) {
  return World.create({
    worldId: new WorldId(crypto.randomUUID()),
    creatorId: new UserId(crypto.randomUUID()),
    title: 'Test World',
    description: 'A test',
    status: new WorldStatus(overrides.status ?? 'published'),
    metadata: overrides.metadata ?? {},
  });
}

describe('ListPublishedWorldsUseCase', () => {
  it('passes filters to the repository and maps taxonomy fields', async () => {
    const world = makeWorld({ metadata: { genre: 'fantasy', tags: ['dark-fantasy'] } });
    const repo = { findPublished: vi.fn().mockResolvedValue([world]) };
    const uc = new ListPublishedWorldsUseCase(repo as any);
    const result = await uc.execute({ genre: 'fantasy', tag: 'dark-fantasy', search: 'test', limit: 10, offset: 0 });
    expect(repo.findPublished).toHaveBeenCalledWith({
      genre: 'fantasy', tag: 'dark-fantasy', search: 'test', limit: 10, offset: 0,
    });
    expect(result[0].genre).toBe('fantasy');
    expect(result[0].tags).toEqual(['dark-fantasy']);
  });

  it('returns null genre and empty tags for uncategorized worlds', async () => {
    const world = makeWorld();
    const repo = { findPublished: vi.fn().mockResolvedValue([world]) };
    const uc = new ListPublishedWorldsUseCase(repo as any);
    const result = await uc.execute({});
    expect(result[0].genre).toBeNull();
    expect(result[0].tags).toEqual([]);
  });

  it('rejects invalid genre', async () => {
    const repo = { findPublished: vi.fn() };
    const uc = new ListPublishedWorldsUseCase(repo as any);
    await expect(uc.execute({ genre: 'not-a-genre' })).rejects.toThrow();
    expect(repo.findPublished).not.toHaveBeenCalled();
  });

  it('normalizes tag input (lowercase, trim)', async () => {
    const repo = { findPublished: vi.fn().mockResolvedValue([]) };
    const uc = new ListPublishedWorldsUseCase(repo as any);
    await uc.execute({ tag: '  Dark-Fantasy ' });
    expect(repo.findPublished).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'dark-fantasy' })
    );
  });

  it('clamps pagination bounds', async () => {
    const repo = { findPublished: vi.fn().mockResolvedValue([]) };
    const uc = new ListPublishedWorldsUseCase(repo as any);
    await uc.execute({ limit: 500, offset: -5 });
    expect(repo.findPublished).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 0 })
    );
  });
});
