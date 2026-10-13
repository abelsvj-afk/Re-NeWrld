import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pkg from 'pg';
import { setPool, closePool } from '../../src/shared/database/db.js';
import { runMigrations } from '../../scripts/migrate.js';
import { PostgresCanonRepository } from '../../src/modules/world/infrastructure/persistence/postgres-canon.repository.js';
import { CanonSnapshot } from '../../src/modules/world/domain/entities/canon-snapshot.entity.js';
import { SnapshotId } from '../../src/modules/world/domain/value-objects/snapshot-id.value-object.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';

const { Pool } = pkg;

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

// Authoritative enforcement tests for Task E2c (migration 005). VERIFIED
// 2026-10-13 against real PostgreSQL 16.2 (local install via
// TEST_DATABASE_URL; Testcontainers path unchanged as the default).
describeFn('Canon snapshot immutability (migration 005)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pkg.Pool;
  let repo: PostgresCanonRepository;
  const worldId = new WorldId(crypto.randomUUID());
  const sceneId = new SceneId(crypto.randomUUID());
  let snapshotId: string;

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
      pool = new Pool({ connectionString });

      const creatorId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [creatorId, 'canon@immutability.test', 'hash', 'creator']
      );
      await pool.query(
        `INSERT INTO worlds (world_id, creator_id, title, description, metadata, status)
         VALUES ($1, $2, 'Immutable World', NULL, '{}', 'published') ON CONFLICT DO NOTHING`,
        [worldId.getValue(), creatorId]
      );

      repo = new PostgresCanonRepository();
      const snapshot = CanonSnapshot.create({
        snapshotId: SnapshotId.generate(),
        worldId,
        versionNumber: 1,
        canonData: {
          canon_schema_version: 1,
          world: {
            world_id: worldId.getValue(),
            title: 'Immutable World',
            description: null,
            metadata: {},
            start_scene_id: sceneId.getValue(),
          },
          scenes: [
            {
              scene_id: sceneId.getValue(),
              chapter_id: crypto.randomUUID(),
              title: 'Only Scene',
              prose: 'Prose.',
              metadata: {},
              is_ending: true,
            },
          ],
          choices: [],
        },
      });
      await repo.insert(snapshot);
      snapshotId = snapshot.getSnapshotId().getValue();
    } catch (err) {
      throw new Error(`Docker container startup or migration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  afterAll(async () => {
    try {
      await pool?.end();
    } catch {}
    try {
      await closePool();
    } catch {}
    if (container) {
      await container.stop();
    }
  });

  /**
   * Runs a mutating statement inside an explicit transaction and recovers it.
   * PostgreSQL marks a transaction as failed after an uncaught statement
   * error (refinement 1): the ROLLBACK below restores a usable connection so
   * the test keeps asserting trigger behavior instead of transaction state.
   */
  async function expectRejected(sql: string, params: unknown[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let thrown: unknown = null;
      try {
        await client.query(sql, params as unknown[]);
      } catch (err) {
        thrown = err;
      }
      await client.query('ROLLBACK');
      expect(thrown).not.toBeNull();
      const pgErr = thrown as { code?: string; message?: string };
      expect(pgErr.code).toBe('P0001');
      expect(pgErr.message).toContain('immutable');
      // Connection recovered: the row is untouched.
      const check = await client.query(
        'SELECT COUNT(*)::int AS n FROM published_canon_snapshots WHERE snapshot_id = $1',
        [snapshotId]
      );
      expect(check.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  }

  it('INSERT still works with the trigger present', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM published_canon_snapshots');
    const second = CanonSnapshot.create({
      snapshotId: SnapshotId.generate(),
      worldId,
      versionNumber: 2,
      canonData: {
        canon_schema_version: 1,
        world: {
          world_id: worldId.getValue(),
          title: 'Immutable World',
          description: null,
          metadata: {},
          start_scene_id: sceneId.getValue(),
        },
        scenes: [],
        choices: [],
      },
    });
    // An empty scene list is fine for the immutability test; the trigger only
    // guards mutation, not canon validity.
    await expect(repo.insert(second)).resolves.toBeUndefined();
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM published_canon_snapshots');
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('whole-row UPDATE is rejected', async () => {
    await expectRejected(
      `UPDATE published_canon_snapshots SET canon_data = $1 WHERE snapshot_id = $2`,
      ['{"canon_schema_version":1}', snapshotId]
    );
  });

  it('single-column UPDATE is rejected', async () => {
    await expectRejected(
      `UPDATE published_canon_snapshots SET published_at = NOW() WHERE snapshot_id = $1`,
      [snapshotId]
    );
  });

  it('DELETE is rejected', async () => {
    await expectRejected(`DELETE FROM published_canon_snapshots WHERE snapshot_id = $1`, [snapshotId]);
  });
});
