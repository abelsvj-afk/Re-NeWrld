import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pkg from 'pg';
import { setPool, closePool } from '../../src/shared/database/db.js';
import { runMigrations } from '../../scripts/migrate.js';

const { Pool } = pkg;

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

// Authoritative enforcement tests for migration 008 (STOP-4). Closes H6:
// reader_timelines is now immutable via trigger, not just code convention.
describeFn('Reader timeline immutability (migration 008)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pkg.Pool;
  const sessionId = crypto.randomUUID();
  const sceneId = crypto.randomUUID();

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

    // Seed a minimal timeline row.
    const readerId = crypto.randomUUID();
    const worldId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [readerId, `tl-${Date.now()}@rene.wrld`, 'x', 'reader']
    );
    await pool.query(
      `INSERT INTO worlds (world_id, creator_id, title, status) VALUES ($1, $2, $3, 'published') ON CONFLICT DO NOTHING`,
      [worldId, readerId, 'TL']
    );
    await pool.query(
      `INSERT INTO published_canon_snapshots (snapshot_id, world_id, version_number, canon_data) VALUES ($1, $2, 1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [snapshotId, worldId]
    );
    await pool.query(
      `INSERT INTO reader_sessions (session_id, reader_id, world_id, snapshot_id, current_scene_id, state_variables, version, status)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 1, 'active') ON CONFLICT DO NOTHING`,
      [sessionId, readerId, worldId, snapshotId, sceneId]
    );
    await pool.query(
      `INSERT INTO reader_timelines (session_id, sequence_number, from_scene_id, to_scene_id, choice_id, state_diff)
       VALUES ($1, 1, $2, $2, $3, '{"kind":"choice-execution-v1","applied":[]}'::jsonb) ON CONFLICT DO NOTHING`,
      [sessionId, sceneId, crypto.randomUUID()]
    );
  });

  afterAll(async () => {
    await closePool().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

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
    } finally {
      client.release();
    }
  }

  it('UPDATE is rejected', async () => {
    await expectRejected(
      `UPDATE reader_timelines SET state_diff = '{}'::jsonb WHERE session_id = $1`,
      [sessionId]
    );
  });

  it('DELETE is rejected', async () => {
    await expectRejected(`DELETE FROM reader_timelines WHERE session_id = $1`, [sessionId]);
  });

  it('INSERT still works (append-only)', async () => {
    await pool.query(
      `INSERT INTO reader_timelines (session_id, sequence_number, from_scene_id, to_scene_id, choice_id, state_diff)
       VALUES ($1, 2, $2, $2, $3, '{}'::jsonb)`,
      [sessionId, sceneId, crypto.randomUUID()]
    );
    const r = await pool.query(`SELECT COUNT(*) AS c FROM reader_timelines WHERE session_id = $1`, [sessionId]);
    expect(Number(r.rows[0].c)).toBe(2);
  });
});
