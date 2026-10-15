import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresWorldRepository } from '../../src/modules/world/infrastructure/persistence/postgres-world.repository.js';
import { ListPublishedWorldsUseCase } from '../../src/modules/world/application/list-published-worlds.use-case.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { WorldStatus } from '../../src/modules/world/domain/value-objects/world-status.value-object.js';
import crypto from 'node:crypto';

// Requires Docker/Testcontainers — runs in CI.
describe('Published world catalog (integration)', () => {
  it('returns only published worlds across creators, with filters', async () => {
    const repo = new PostgresWorldRepository();
    const creatorA = new UserId(crypto.randomUUID());
    const creatorB = new UserId(crypto.randomUUID());

    const published = World.create({
      worldId: new WorldId(crypto.randomUUID()),
      creatorId: creatorA,
      title: 'Fantasy Epic',
      description: 'A grand tale',
      status: new WorldStatus('published'),
      metadata: { genre: 'fantasy', tags: ['epic'] },
    });
    const draft = World.create({
      worldId: new WorldId(crypto.randomUUID()),
      creatorId: creatorA,
      title: 'Secret Draft',
      description: 'Not ready',
      status: new WorldStatus('draft'),
      metadata: {},
    });
    const otherCreator = World.create({
      worldId: new WorldId(crypto.randomUUID()),
      creatorId: creatorB,
      title: 'Sci-Fi Story',
      description: 'In space',
      status: new WorldStatus('published'),
      metadata: { genre: 'sci-fi' },
    });

    await repo.save(published);
    await repo.save(draft);
    await repo.save(otherCreator);

    const uc = new ListPublishedWorldsUseCase(repo);

    const all = await uc.execute({});
    const ids = all.map((w) => w.id);
    expect(ids).toContain(published.getWorldId().getValue());
    expect(ids).toContain(otherCreator.getWorldId().getValue());
    expect(ids).not.toContain(draft.getWorldId().getValue());

    const fantasy = await uc.execute({ genre: 'fantasy' });
    expect(fantasy.map((w) => w.id)).toEqual([published.getWorldId().getValue()]);

    const tagged = await uc.execute({ tag: 'epic' });
    expect(tagged.map((w) => w.id)).toEqual([published.getWorldId().getValue()]);

    // Cleanup
    await repo.delete(published.getWorldId());
    await repo.delete(draft.getWorldId());
    await repo.delete(otherCreator.getWorldId());
  });
});
