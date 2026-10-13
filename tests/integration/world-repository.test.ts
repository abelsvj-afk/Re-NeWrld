import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setPool, closePool, query } from '../../src/shared/database/db.js';
import { runMigrations } from '../../scripts/migrate.js';
import { PostgresWorldRepository } from '../../src/modules/world/infrastructure/persistence/postgres-world.repository.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { WorldValidationError } from '../../src/modules/world/domain/errors/world.errors.js';

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

describeFn('PostgresWorldRepository Integration (UNVERIFIED if Docker unavailable)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let repo: PostgresWorldRepository;
  const creator1Id = new UserId('123e4567-e89b-42d3-a456-426614174000');
  const creator2Id = new UserId('987fcdeb-5022-42d3-a456-426614174001');

  beforeAll(async () => {
    try {
      // TEST_DATABASE_URL: run against a real, externally-managed PostgreSQL
      // (e.g. a local install) instead of Testcontainers. Same tests against
      // the same real database engine — only the provisioning differs.
      const externalUrl = process.env.TEST_DATABASE_URL;
      let connectionString: string;
      if (externalUrl) {
        connectionString = externalUrl;
      } else {
        container = await new PostgreSqlContainer('postgres:15-alpine').start();
        connectionString = container.getConnectionUri();
      }
      await runMigrations(connectionString);
      setPool(connectionString);

      await query(
        `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [
          creator1Id.getValue(),
          'creator1@repo.test',
          'hash1',
          'creator',
          creator2Id.getValue(),
          'creator2@repo.test',
          'hash2',
          'creator',
        ]
      );

      repo = new PostgresWorldRepository();
    } catch (err) {
      throw new Error(`Docker container startup or migration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  afterAll(async () => {
    try {
      await closePool();
    } catch {}
    if (container) {
      await container.stop();
    }
  });

  it('should perform round trip save and findById including status and createdAt', async () => {
    const worldId = WorldId.generate();
    const world = World.create({
      worldId,
      creatorId: creator1Id,
      title: 'Repository Test World',
      description: 'Testing persistence',
    });

    await repo.save(world);
    const found = await repo.findById(worldId);

    expect(found).not.toBeNull();
    expect(found?.getTitle()).toBe('Repository Test World');
    expect(found?.getStatus().getValue()).toBe('draft');
    expect(found?.getCreatedAt()).toBeDefined();
    expect(found?.getCreatorId().equals(creator1Id)).toBe(true);
  });

  it('should persist owner update successfully', async () => {
    const worldId = WorldId.generate();
    const world = World.create({
      worldId,
      creatorId: creator1Id,
      title: 'Original Title',
    });

    await repo.save(world);
    world.updateTitle('Updated Title by Owner');
    await repo.save(world);

    const found = await repo.findById(worldId);
    expect(found?.getTitle()).toBe('Updated Title by Owner');
  });

  it('should isolate findByCreatorId between two creators', async () => {
    const w1Id = WorldId.generate();
    const w1 = World.create({ worldId: w1Id, creatorId: creator1Id, title: 'Creator 1 World' });
    await repo.save(w1);

    const w2Id = WorldId.generate();
    const w2 = World.create({ worldId: w2Id, creatorId: creator2Id, title: 'Creator 2 World' });
    await repo.save(w2);

    const c1Worlds = await repo.findByCreatorId(creator1Id);
    expect(c1Worlds.some((w) => w.getWorldId().equals(w1Id))).toBe(true);
    expect(c1Worlds.some((w) => w.getWorldId().equals(w2Id))).toBe(false);
  });

  it('should leave creator_id unchanged on save with existing ID but different creator', async () => {
    const worldId = WorldId.generate();
    const world1 = World.create({ worldId, creatorId: creator1Id, title: 'Creator 1 Initial' });
    await repo.save(world1);

    const world2 = World.create({ worldId, creatorId: creator2Id, title: 'Attempted Hijack Title' });
    await repo.save(world2);

    const found = await repo.findById(worldId);
    expect(found?.getTitle()).toBe('Attempted Hijack Title');
    expect(found?.getCreatorId().equals(creator1Id)).toBe(true);
  });

  it('should save 255-char title and reject 256-char title before DB', () => {
    const title255 = 'a'.repeat(255);
    const okWorld = World.create({
      worldId: WorldId.generate(),
      creatorId: creator1Id,
      title: title255,
    });
    expect(okWorld.getTitle().length).toBe(255);

    const title256 = 'a'.repeat(256);
    expect(() =>
      World.create({
        worldId: WorldId.generate(),
        creatorId: creator1Id,
        title: title256,
      })
    ).toThrowError(WorldValidationError);
  });
});
