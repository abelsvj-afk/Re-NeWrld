import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pkg from 'pg';
import { setPool, closePool } from '../../src/shared/database/db.js';
import { runMigrations } from '../../scripts/migrate.js';
import {
  PublishWorldUseCase,
  PublishWorldResult,
} from '../../src/modules/world/application/publish-world.use-case.js';
import { PostgresWorldRepository } from '../../src/modules/world/infrastructure/persistence/postgres-world.repository.js';
import { PostgresSceneRepository } from '../../src/modules/world/infrastructure/persistence/postgres-scene.repository.js';
import { PostgresChoiceRepository } from '../../src/modules/world/infrastructure/persistence/postgres-choice.repository.js';
import { PostgresCanonRepository } from '../../src/modules/world/infrastructure/persistence/postgres-canon.repository.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';

const { Pool } = pkg;

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

// Closes verification-track item 4: concurrent publishes of the same world
// must produce distinct snapshot versions. PostgresCanonRepository.nextVersion
// takes a transaction-scoped advisory lock (namespaced per world) before
// MAX(version_number)+1, so overlapping publish transactions serialize on
// version allocation instead of producing duplicates.
//
// VERIFIED 2026-10-13: 5 concurrent publishes -> distinct versions 1..5,
// passed against real PostgreSQL 16.2 (local install via TEST_DATABASE_URL;
// Testcontainers path unchanged as the default), stable across consecutive
// runs against the same database.
// TEST_DATABASE_URL: run against a real, externally-managed PostgreSQL
// (e.g. a local install) instead of Testcontainers. Same tests against
// the same real database engine — only the provisioning differs.
describeFn('Concurrent publishing (E2a advisory lock)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pkg.Pool;
  const creatorId = new UserId(crypto.randomUUID());
  const worldId = new WorldId(crypto.randomUUID());

  beforeAll(async () => {
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
    pool = new Pool({ connectionString });

    // Minimal publishable graph: start scene -> ending scene.
    const chapterId = crypto.randomUUID();
    const startSceneId = crypto.randomUUID();
    const endingSceneId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [creatorId.getValue(), `concurrent-pub-${creatorId.getValue()}@test`, 'hash', 'creator']
    );
    await pool.query(
      `INSERT INTO worlds (world_id, creator_id, title, description, metadata, status)
       VALUES ($1, $2, 'Concurrent World', NULL, '{}', 'draft') ON CONFLICT DO NOTHING`,
      [worldId.getValue(), creatorId.getValue()]
    );
    await pool.query(
      `INSERT INTO chapters (chapter_id, world_id, title) VALUES ($1, $2, 'Ch 1') ON CONFLICT DO NOTHING`,
      [chapterId, worldId.getValue()]
    );
    await pool.query(
      `INSERT INTO scenes (scene_id, world_id, chapter_id, title, prose, is_ending)
       VALUES ($1, $2, $3, 'Start', 'Begin.', false),
              ($4, $2, $3, 'Ending', 'The end.', true)
       ON CONFLICT DO NOTHING`,
      [startSceneId, worldId.getValue(), chapterId, endingSceneId]
    );
    await pool.query(
      `INSERT INTO choices (world_id, scene_id, target_scene_id, text)
       VALUES ($1, $2, $3, 'Go') ON CONFLICT DO NOTHING`,
      [worldId.getValue(), startSceneId, endingSceneId]
    );
    await pool.query(`UPDATE worlds SET start_scene_id = $1 WHERE world_id = $2`, [
      startSceneId,
      worldId.getValue(),
    ]);
  });

  afterAll(async () => {
    await closePool().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

  it('concurrent publishes of the same world produce distinct versions 1..N', async () => {
    const useCase = new PublishWorldUseCase(
      new PostgresWorldRepository(),
      new PostgresSceneRepository(),
      new PostgresChoiceRepository(),
      new PostgresCanonRepository()
    );
    const N = 5;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => useCase.execute({ worldId, creatorId }))
    );
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<PublishWorldResult> => r.status === 'fulfilled'
    );
    // Every concurrent publish succeeds — the advisory lock serializes
    // version allocation; nothing is lost or duplicated.
    expect(fulfilled).toHaveLength(N);
    const versions = fulfilled.map((r) => r.value.snapshot.getVersionNumber());
    expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
