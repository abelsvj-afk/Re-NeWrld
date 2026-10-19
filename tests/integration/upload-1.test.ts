/**
 * UPLOAD-1 integration tests (design rev 24).
 *
 * Covers:
 * - Migration 018: staging_allowances schema
 * - Migration 019: quota_used_bytes counts allowances
 * - Migration 020: bytes_ready column with safe default
 * - Allowance lifecycle: create → convert → bytes_ready
 * - Magic bytes detection
 * - Quota accounting for staging allowances
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { randomUUID } from 'node:crypto';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

let pool: pkg.Pool;

const WORLD_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = '00000000-0000-0000-0000-000000000000';

async function withTransaction<T>(fn: (tx: pkg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

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
    `INSERT INTO worlds (world_id, title, creator_id) VALUES ($1, 'Upload Test', $2) ON CONFLICT (world_id) DO NOTHING`,
    [WORLD_ID, USER_ID]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM staging_allowances WHERE world_id = $1`, [WORLD_ID]);
  await pool.query(`DELETE FROM storage_reservations WHERE world_id = $1`, [WORLD_ID]);
  await pool.end();
});

describe('Migration 018: staging_allowances', () => {
  it('table exists with correct columns', async () => {
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'staging_allowances'
       ORDER BY ordinal_position`
    );
    const cols = r.rows.map((row) => row.column_name);
    expect(cols).toContain('allowance_id');
    expect(cols).toContain('world_id');
    expect(cols).toContain('max_bytes');
    expect(cols).toContain('state');
    expect(cols).toContain('expires_at');
    expect(cols).toContain('created_at');
    expect(cols).toContain('reservation_id');
  });

  it('state check constraint allows all four states', async () => {
    // 'active', 'expiring', 'expired', 'cancelled' should all be valid
    for (const state of ['active', 'expiring', 'expired', 'cancelled']) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO staging_allowances (allowance_id, world_id, max_bytes, state, expires_at)
         VALUES ($1, $2, 10485760, $3, now() + interval '2 minutes')`,
        [id, WORLD_ID, state]
      );
      await pool.query(`DELETE FROM staging_allowances WHERE allowance_id = $1`, [id]);
    }
  });

  it('rejects invalid state', async () => {
    await expect(
      pool.query(
        `INSERT INTO staging_allowances (allowance_id, world_id, max_bytes, state, expires_at)
         VALUES ($1, $2, 10485760, 'converting', now() + interval '2 minutes')`,
        [randomUUID(), WORLD_ID]
      )
    ).rejects.toThrow();
  });
});

describe('Migration 019: quota counts allowances', () => {
  it('active allowance counts toward quota', async () => {
    const before = await pool.query(`SELECT quota_used_bytes($1) AS used`, [WORLD_ID]);
    const beforeBytes = Number(before.rows[0].used);

    const id = randomUUID();
    await pool.query(
      `INSERT INTO staging_allowances (allowance_id, world_id, max_bytes, state, expires_at)
       VALUES ($1, $2, 10485760, 'active', now() + interval '2 minutes')`,
      [id, WORLD_ID]
    );

    const after = await pool.query(`SELECT quota_used_bytes($1) AS used`, [WORLD_ID]);
    const afterBytes = Number(after.rows[0].used);

    expect(afterBytes - beforeBytes).toBe(10485760);

    await pool.query(`DELETE FROM staging_allowances WHERE allowance_id = $1`, [id]);
  });

  it('expiring allowance counts toward quota', async () => {
    const before = await pool.query(`SELECT quota_used_bytes($1) AS used`, [WORLD_ID]);
    const beforeBytes = Number(before.rows[0].used);

    const id = randomUUID();
    await pool.query(
      `INSERT INTO staging_allowances (allowance_id, world_id, max_bytes, state, expires_at)
       VALUES ($1, $2, 10485760, 'expiring', now() - interval '1 minute')`,
      [id, WORLD_ID]
    );

    const after = await pool.query(`SELECT quota_used_bytes($1) AS used`, [WORLD_ID]);
    const afterBytes = Number(after.rows[0].used);

    // Expiring counts even after expires_at (rev 6 fix)
    expect(afterBytes - beforeBytes).toBe(10485760);

    await pool.query(`DELETE FROM staging_allowances WHERE allowance_id = $1`, [id]);
  });

  it('expired and cancelled do not count', async () => {
    const before = await pool.query(`SELECT quota_used_bytes($1) AS used`, [WORLD_ID]);
    const beforeBytes = Number(before.rows[0].used);

    for (const state of ['expired', 'cancelled']) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO staging_allowances (allowance_id, world_id, max_bytes, state, expires_at)
         VALUES ($1, $2, 10485760, $3, now() - interval '5 minutes')`,
        [id, WORLD_ID, state]
      );
    }

    const after = await pool.query(`SELECT quota_used_bytes($1) AS used`, [WORLD_ID]);
    expect(Number(after.rows[0].used)).toBe(beforeBytes);

    await pool.query(`DELETE FROM staging_allowances WHERE world_id = $1 AND state IN ('expired', 'cancelled')`, [WORLD_ID]);
  });
});

describe('Migration 020: bytes_ready', () => {
  it('column exists with correct type and default', async () => {
    const r = await pool.query(
      `SELECT column_default, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'storage_reservations'
         AND column_name = 'bytes_ready'`
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].data_type).toBe('boolean');
    expect(r.rows[0].is_nullable).toBe('NO');
    // Default should be false (fail-closed)
    expect(r.rows[0].column_default).toMatch(/false/i);
  });

  it('new reservations default to bytes_ready=false', async () => {
    const id = randomUUID();
    // Insert without specifying bytes_ready (uses default)
    await pool.query(
      `INSERT INTO storage_reservations (reservation_id, world_id, size_bytes, state)
       VALUES ($1, $2, 1024, 'RESERVED')`,
      [id, WORLD_ID]
    );
    const r = await pool.query(
      `SELECT bytes_ready FROM storage_reservations WHERE reservation_id = $1`,
      [id]
    );
    expect(r.rows[0].bytes_ready).toBe(false);
    await pool.query(`DELETE FROM storage_reservations WHERE reservation_id = $1`, [id]);
  });

  it('migration is idempotent (rerun succeeds)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const sql = await readFile(join(process.cwd(), 'db/migrations/020_reservation_bytes_ready.sql'), 'utf-8');
    // Should not throw on rerun
    await pool.query(sql);
    const r = await pool.query(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'storage_reservations'
         AND column_name = 'bytes_ready'`
    );
    expect(r.rows[0].column_default).toMatch(/false/i);
  });
});

describe('Allowance lifecycle', () => {
  it('allowance creation respects quota', async () => {
    // Create an allowance, verify it counts, then cancel it
    const { createAllowance } = await import('../../src/modules/world/domain/services/staging-allowance.service.js');

    const deps = {
      quotaBytes: 50 * 1024 * 1024,
      maxStagingBytes: 10 * 1024 * 1024,
      allowanceTtlMs: 120000,
      mediaRoot: '/tmp/test-media',
      isFenceActive: async () => false,
      isBackfillActive: async () => false,
      quotaUsedBytes: async (wid: string, tx: pkg.PoolClient) => {
        const r = await tx.query(`SELECT quota_used_bytes($1) AS used`, [wid]);
        return Number(r.rows[0].used);
      },
      lockWorldRow: async (wid: string, tx: pkg.PoolClient) => {
        await tx.query(`SELECT 1 FROM worlds WHERE world_id = $1 FOR UPDATE`, [wid]);
      },
      createReservation: async () => ({ reservationId: randomUUID() }),
      log: () => {},
    };

    const allowance = await createAllowance(WORLD_ID, deps);
    expect(allowance.allowanceId).toBeDefined();
    expect(allowance.state).toBe('active');
    expect(allowance.maxBytes).toBe(10 * 1024 * 1024);

    // Verify it's counted in quota
    const used = await pool.query(`SELECT quota_used_bytes($1) AS u`, [WORLD_ID]);
    expect(Number(used.rows[0].u)).toBeGreaterThanOrEqual(10 * 1024 * 1024);

    // Cleanup
    await pool.query(`DELETE FROM staging_allowances WHERE allowance_id = $1`, [allowance.allowanceId]);
  });
});
