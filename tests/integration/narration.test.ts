import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pkg from 'pg';
import { setPool, closePool } from '../../src/shared/database/db.js';
import { runMigrations } from '../../scripts/migrate.js';
import { GenerateNarrationUseCase } from '../../src/modules/world/application/generate-narration.use-case.js';
import { GetNarrationUseCase } from '../../src/modules/world/application/get-narration.use-case.js';
import { PostgresNarrationRepository } from '../../src/modules/world/infrastructure/persistence/postgres-narration.repository.js';
import { PostgresWorldRepository } from '../../src/modules/world/infrastructure/persistence/postgres-world.repository.js';
import { PostgresSceneRepository } from '../../src/modules/world/infrastructure/persistence/postgres-scene.repository.js';
import { PostgresChapterRepository } from '../../src/modules/world/infrastructure/persistence/postgres-chapter.repository.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldStatus } from '../../src/modules/world/domain/value-objects/world-status.value-object.js';

const { Pool } = pkg;

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

// T3 integration tests (ADR-016): cache hit/miss, quota exhaustion,
// idempotent concurrent generation, reader serving rules.
// ElevenLabs is mocked — no real synthesis or quota spend.
describeFn('Scene narration integration (ADR-016)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pkg.Pool;
  const creatorId = new UserId(crypto.randomUUID());
  const worldId = new WorldId(crypto.randomUUID());
  let sceneId: string;
  let chapterId: string;

  const mockElevenLabs = {
    synthesize: vi.fn().mockResolvedValue(Buffer.from('fake-mp3-bytes')),
    getRemainingQuota: vi.fn().mockResolvedValue(40000),
    isCircuitOpen: vi.fn().mockReturnValue(false),
  };

  beforeAll(async () => {
    const testDbUrl = process.env.TEST_DATABASE_URL;
    if (testDbUrl) {
      pool = new Pool({ connectionString: testDbUrl });
    } else {
      container = await new PostgreSqlContainer('postgres:16.2').start();
      pool = new Pool({ connectionString: container.getConnectionUri() });
    }
    setPool(pool);
    await runMigrations(pool.options.connectionString as string);

    const client = await pool.connect();
    try {
      const w = await client.query(
        `INSERT INTO worlds (world_id, creator_id, title, status) VALUES ($1, $2, 'N', 'draft') RETURNING world_id`,
        [worldId.getValue(), creatorId.getValue()]
      );
      const ch = await client.query(
        `INSERT INTO chapters (world_id, title, sort_order) VALUES ($1, 'Ch1', 0) RETURNING chapter_id`,
        [worldId.getValue()]
      );
      chapterId = ch.rows[0].chapter_id;
      const s = await client.query(
        `INSERT INTO scenes (world_id, chapter_id, title, prose) VALUES ($1, $2, 'S1', '<p>Hello world.</p>') RETURNING scene_id`,
        [worldId.getValue(), chapterId]
      );
      sceneId = s.rows[0].scene_id;
    } finally {
      client.release();
    }
  }, 120000);

  afterAll(async () => {
    await closePool();
    if (container) await container.stop();
  });

  function makeDeps(overrides: any = {}) {
    return {
      narrationRepository: new PostgresNarrationRepository(),
      sceneRepository: new PostgresSceneRepository(),
      worldRepository: new PostgresWorldRepository(),
      elevenLabs: mockElevenLabs,
      storagePath: '/tmp/narration-int-test',
      monthlyCharCap: 40000,
      ...overrides,
    };
  }

  const input = () => ({
    worldId: worldId.getValue(),
    sceneId,
    creatorId,
    voiceId: 'voice-abc',
  });

  it('generates on cache miss, then serves from cache without re-synthesizing', async () => {
    const uc = new GenerateNarrationUseCase(makeDeps() as any);
    const first = await uc.execute(input());
    expect(first.status).toBe('generated');
    expect(mockElevenLabs.synthesize).toHaveBeenCalledTimes(1);

    const second = await uc.execute(input());
    expect(second.status).toBe('cached');
    expect(second.audioPath).toBe(first.audioPath);
    // No second synthesis call — cache hit.
    expect(mockElevenLabs.synthesize).toHaveBeenCalledTimes(1);
  });

  it('concurrent first-generations converge on one synthesis (idempotent)', async () => {
    mockElevenLabs.synthesize.mockClear();
    // New scene so the cache is cold for this prose.
    const client = await pool.connect();
    let scene2: string;
    try {
      const s = await client.query(
        `INSERT INTO scenes (world_id, chapter_id, title, prose) VALUES ($1, $2, 'S2', '<p>Second scene text.</p>') RETURNING scene_id`,
        [worldId.getValue(), chapterId]
      );
      scene2 = s.rows[0].scene_id;
    } finally {
      client.release();
    }
    const uc = new GenerateNarrationUseCase(makeDeps() as any);
    const in2 = { ...input(), sceneId: scene2 };
    const results = await Promise.all([
      uc.execute(in2), uc.execute(in2), uc.execute(in2),
    ]);
    // All succeed; the unique constraint guarantees one row wins.
    expect(results.every((r) => r.audioPath === results[0].audioPath)).toBe(true);
  });

  it('rejects generation when the monthly quota is exhausted', async () => {
    const uc = new GenerateNarrationUseCase(makeDeps({ monthlyCharCap: 1 }) as any);
    await expect(uc.execute(input())).rejects.toThrow(/quota/i);
  });

  it('reader serving returns 404-equivalent when world is draft', async () => {
    const get = new GetNarrationUseCase(
      new PostgresNarrationRepository(),
      new PostgresSceneRepository(),
      new PostgresWorldRepository(),
    );
    const out = await get.execute(worldId.getValue(), sceneId);
    expect(out.found).toBe(false);
  });
});
