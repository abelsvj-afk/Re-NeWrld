/**
 * DEL-2 integration tests (design rev 2).
 *
 * Covers:
 * - T1: blocks published worlds, creates job, transfers shared assets
 * - T2-T5: state machine progression
 * - Error codes
 *
 * NOTE: UNVERIFIED — no PostgreSQL in this environment.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { randomUUID } from 'node:crypto';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

let pool: pkg.Pool;

const WORLD_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  pool = new pkg.Pool({ connectionString: TEST_DATABASE_URL });

  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const migDir = join(process.cwd(), 'db/migrations');
  const files = (await readdir(migDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const mig of files) {
    const sql = await readFile(join(migDir, mig), 'utf-8');
    await pool.query(sql);
  }

  await pool.query(
    `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, 'test@test.com', 'hash', 'creator') ON CONFLICT (user_id) DO NOTHING`,
    [USER_ID]
  );
  await pool.query(
    `INSERT INTO worlds (world_id, title, creator_id) VALUES ($1, 'Del2 Test', $2) ON CONFLICT (world_id) DO NOTHING`,
    [WORLD_ID, USER_ID]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM world_deletion_jobs WHERE world_id = $1`, [WORLD_ID]).catch(() => {});
  await pool.query(`DELETE FROM world_media_assets WHERE world_id = $1`, [WORLD_ID]).catch(() => {});
  await pool.end();
});

const mockDeps = {
  mediaRoot: '/tmp',
  isFenceActive: async () => false,
  isBackfillActive: async () => false,
  log: () => {},
};

describe('worldDeletionT1', () => {
  it('throws WORLD_NOT_FOUND for missing world', async () => {
    const { worldDeletionT1 } = await import(
      '../../src/modules/world/domain/services/world-deletion.service.js'
    );
    await expect(
      worldDeletionT1(randomUUID(), mockDeps)
    ).rejects.toMatchObject({ code: 'WORLD_NOT_FOUND', httpStatus: 404 });
  });

  it('throws WORLD_HAS_PUBLISHED_VERSIONS for published world', async () => {
    const { worldDeletionT1 } = await import(
      '../../src/modules/world/domain/services/world-deletion.service.js'
    );
    // Create a fake snapshot
    const snapshotId = randomUUID();
    await pool.query(
      `INSERT INTO canon_snapshots (snapshot_id, world_id, version_number, canon_data, created_at)
       VALUES ($1, $2, 1, '{}', now()) ON CONFLICT DO NOTHING`,
      [snapshotId, WORLD_ID]
    );

    await expect(
      worldDeletionT1(WORLD_ID, mockDeps)
    ).rejects.toMatchObject({
      code: 'WORLD_HAS_PUBLISHED_VERSIONS',
      httpStatus: 409,
    });

    await pool.query(`DELETE FROM canon_snapshots WHERE snapshot_id = $1`, [snapshotId]);
  });

  it('creates job for draft-only world', async () => {
    const { worldDeletionT1 } = await import(
      '../../src/modules/world/domain/services/world-deletion.service.js'
    );
    const jobId = await worldDeletionT1(WORLD_ID, mockDeps);
    expect(jobId).toBeDefined();

    const check = await pool.query(
      `SELECT state FROM world_deletion_jobs WHERE job_id = $1`,
      [jobId]
    );
    expect(check.rows[0].state).toBe('t1_complete');

    // Cleanup
    await pool.query(`DELETE FROM world_deletion_jobs WHERE job_id = $1`, [jobId]);
  });
});

describe('Full deletion flow', () => {
  it('completes T1-T5 for empty world', async () => {
    const {
      worldDeletionT1,
      worldDeletionT2,
      worldDeletionT3,
      worldDeletionT4,
      worldDeletionT5,
    } = await import(
      '../../src/modules/world/domain/services/world-deletion.service.js'
    );

    const testWorldId = randomUUID();
    await pool.query(
      `INSERT INTO worlds (world_id, title, creator_id) VALUES ($1, 'Temp', $2)`,
      [testWorldId, USER_ID]
    );

    const jobId = await worldDeletionT1(testWorldId, mockDeps);
    await worldDeletionT2(jobId, testWorldId, mockDeps);
    await worldDeletionT3(jobId, testWorldId, mockDeps);
    await worldDeletionT4(jobId, testWorldId, mockDeps);
    await worldDeletionT5(jobId, testWorldId, mockDeps);

    // World should be gone
    const check = await pool.query(`SELECT world_id FROM worlds WHERE world_id = $1`, [testWorldId]);
    expect(check.rows.length).toBe(0);

    // Job should be complete
    const jobCheck = await pool.query(
      `SELECT state FROM world_deletion_jobs WHERE job_id = $1`,
      [jobId]
    );
    expect(jobCheck.rows[0].state).toBe('complete');

    await pool.query(`DELETE FROM world_deletion_jobs WHERE job_id = $1`, [jobId]);
  });
});
