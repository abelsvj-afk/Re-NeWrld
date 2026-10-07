import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../scripts/migrate.js';
import pkg from 'pg';
const { Pool } = pkg;

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

describeFn('Database Migration Integration & Idempotency', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connectionString: string;

  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      process.env.DATABASE_URL = connectionString;
    } catch (err) {
      throw new Error(`Docker daemon / PostgreSQL container startup failed and intentional skip mechanism is not enabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  it('should execute migrations successfully and maintain idempotency', async () => {
    if (!connectionString) {
      throw new Error('Testcontainer connection string is missing.');
    }

    // Run migrations first time
    await runMigrations();

    // Verify schema tables were created
    const pool = new Pool({ connectionString });
    try {
      const res = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      const tables = res.rows.map((r) => r.table_name);
      expect(tables).toContain('users');
      expect(tables).toContain('worlds');
      expect(tables).toContain('scenes');
      expect(tables).toContain('choices');
      expect(tables).toContain('published_canon_snapshots');
      expect(tables).toContain('reader_sessions');
      expect(tables).toContain('reader_timelines');
      expect(tables).toContain('schema_migrations');

      // Verify migration version recorded
      const migRes = await pool.query('SELECT version, name FROM schema_migrations');
      expect(migRes.rows).toHaveLength(1);
      expect(migRes.rows[0].version).toBe(1);

      // Run migrations second time (idempotency check)
      await runMigrations();
      const migRes2 = await pool.query('SELECT version FROM schema_migrations');
      expect(migRes2.rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('should enforce source-scene composite FK (rejecting invalid/nonexistent source scene)', async () => {
    if (!connectionString) {
      throw new Error('Testcontainer connection string is missing.');
    }

    await runMigrations();
    const pool = new Pool({ connectionString });
    try {
      const userRes = await pool.query(`
        INSERT INTO users (email, password_hash, role) 
        VALUES ('creator@test.com', 'hash', 'creator') 
        RETURNING user_id
      `);
      const userId = userRes.rows[0].user_id;

      const worldRes = await pool.query(`
        INSERT INTO worlds (creator_id, title) VALUES ($1, 'World 1') RETURNING world_id
      `, [userId]);
      const worldId = worldRes.rows[0].world_id;

      const chRes = await pool.query(`
        INSERT INTO chapters (world_id, title) VALUES ($1, 'Chapter 1') RETURNING chapter_id
      `, [worldId]);
      const chId = chRes.rows[0].chapter_id;

      const scRes = await pool.query(`
        INSERT INTO scenes (world_id, chapter_id, title, prose) VALUES ($1, $2, 'Scene 1', 'Prose 1') RETURNING scene_id
      `, [worldId, chId]);
      const scId = scRes.rows[0].scene_id;

      const fakeSceneId = '11111111-1111-1111-1111-111111111111';

      // Inserting choice with nonexistent source scene should fail due to fk_choice_scene
      await expect(
        pool.query(`
          INSERT INTO choices (world_id, scene_id, target_scene_id, text) 
          VALUES ($1, $2, $3, 'Invalid Source Choice')
        `, [worldId, fakeSceneId, scId])
      ).rejects.toThrow();

    } finally {
      await pool.end();
    }
  });

  it('should enforce target-scene composite FK (rejecting invalid/nonexistent target scene)', async () => {
    if (!connectionString) {
      throw new Error('Testcontainer connection string is missing.');
    }

    await runMigrations();
    const pool = new Pool({ connectionString });
    try {
      const userRes = await pool.query(`
        INSERT INTO users (email, password_hash, role) 
        VALUES ('creator@test.com', 'hash', 'creator') 
        RETURNING user_id
      `);
      const userId = userRes.rows[0].user_id;

      const worldRes = await pool.query(`
        INSERT INTO worlds (creator_id, title) VALUES ($1, 'World 1') RETURNING world_id
      `, [userId]);
      const worldId = worldRes.rows[0].world_id;

      const chRes = await pool.query(`
        INSERT INTO chapters (world_id, title) VALUES ($1, 'Chapter 1') RETURNING chapter_id
      `, [worldId]);
      const chId = chRes.rows[0].chapter_id;

      const scRes = await pool.query(`
        INSERT INTO scenes (world_id, chapter_id, title, prose) VALUES ($1, $2, 'Scene 1', 'Prose 1') RETURNING scene_id
      `, [worldId, chId]);
      const scId = scRes.rows[0].scene_id;

      const fakeTargetId = '22222222-2222-2222-2222-222222222222';

      // Inserting choice with nonexistent target scene should fail due to fk_choice_target_scene
      await expect(
        pool.query(`
          INSERT INTO choices (world_id, scene_id, target_scene_id, text) 
          VALUES ($1, $2, $3, 'Invalid Target Choice')
        `, [worldId, scId, fakeTargetId])
      ).rejects.toThrow();

    } finally {
      await pool.end();
    }
  });

  it('should enforce same-world referential integrity for choices referencing cross-world target scenes', async () => {
    if (!connectionString) {
      throw new Error('Testcontainer connection string is missing.');
    }

    await runMigrations();
    const pool = new Pool({ connectionString });
    try {
      // Create user
      const userRes = await pool.query(`
        INSERT INTO users (email, password_hash, role) 
        VALUES ('creator@test.com', 'hash', 'creator') 
        RETURNING user_id
      `);
      const userId = userRes.rows[0].user_id;

      // Create two worlds
      const world1Res = await pool.query(`
        INSERT INTO worlds (creator_id, title) VALUES ($1, 'World 1') RETURNING world_id
      `, [userId]);
      const world1Id = world1Res.rows[0].world_id;

      const world2Res = await pool.query(`
        INSERT INTO worlds (creator_id, title) VALUES ($1, 'World 2') RETURNING world_id
      `, [userId]);
      const world2Id = world2Res.rows[0].world_id;

      // Create chapter and scene in World 1
      const ch1Res = await pool.query(`
        INSERT INTO chapters (world_id, title) VALUES ($1, 'Chapter 1') RETURNING chapter_id
      `, [world1Id]);
      const ch1Id = ch1Res.rows[0].chapter_id;

      const sc1Res = await pool.query(`
        INSERT INTO scenes (world_id, chapter_id, title, prose) VALUES ($1, $2, 'Scene 1', 'Prose 1') RETURNING scene_id
      `, [world1Id, ch1Id]);
      const sc1Id = sc1Res.rows[0].scene_id;

      // Create chapter and scene in World 2
      const ch2Res = await pool.query(`
        INSERT INTO chapters (world_id, title) VALUES ($1, 'Chapter 2') RETURNING chapter_id
      `, [world2Id]);
      const ch2Id = ch2Res.rows[0].chapter_id;

      const sc2Res = await pool.query(`
        INSERT INTO scenes (world_id, chapter_id, title, prose) VALUES ($1, $2, 'Scene 2', 'Prose 2') RETURNING scene_id
      `, [world2Id, ch2Id]);
      const sc2Id = sc2Res.rows[0].scene_id;

      // Valid choice within World 1 should succeed
      await pool.query(`
        INSERT INTO choices (world_id, scene_id, target_scene_id, text) 
        VALUES ($1, $2, $3, 'Go to Scene 1')
      `, [world1Id, sc1Id, sc1Id]);

      // Cross-world choice (Choice in World 1 targeting Scene 2 in World 2) should fail due to FK constraint
      await expect(
        pool.query(`
          INSERT INTO choices (world_id, scene_id, target_scene_id, text) 
          VALUES ($1, $2, $3, 'Invalid Cross-World Choice')
        `, [world1Id, sc1Id, sc2Id])
      ).rejects.toThrow();

    } finally {
      await pool.end();
    }
  });
});
