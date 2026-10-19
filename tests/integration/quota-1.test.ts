/**
 * QUOTA-1 tests (design rev 8).
 *
 * Covers: quota_used_bytes() SQL, config parsing, file size limit,
 * atomic handoff, world ownership, schema verification.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { randomUUID } from 'node:crypto';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

let pool: pkg.Pool;

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

  const userId = '00000000-0000-0000-0000-000000000000';
  await pool.query(
    `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, 'test@test.com', 'hash', 'creator') ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  await pool.query(
    `INSERT INTO worlds (world_id, title, creator_id) VALUES ('22222222-2222-2222-2222-222222222222', 'Quota Test', $1) ON CONFLICT (world_id) DO NOTHING`,
    [userId]
  );
  await pool.query(
    `INSERT INTO worlds (world_id, title, creator_id) VALUES ('33333333-3333-3333-3333-333333333333', 'Other World', $1) ON CONFLICT (world_id) DO NOTHING`,
    [userId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe('QUOTA-1: quota_used_bytes()', () => {
  it('counts registered + reservations, excludes committed', async () => {
    const worldId = '22222222-2222-2222-2222-222222222222';
    await pool.query(`DELETE FROM world_media_assets WHERE world_id=$1`, [worldId]);
    await pool.query(`DELETE FROM storage_reservations WHERE world_id=$1`, [worldId]);

    // One active asset (10 MB).
    await pool.query(
      `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, lifecycle, file_confirmed_present)
       VALUES ($1, 'a.png', '/media/a.png', 'image/png', 10485760, 'active', true)`,
      [worldId]
    );
    // One pending_deletion asset (5 MB) — still counts.
    await pool.query(
      `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, lifecycle, file_confirmed_present)
       VALUES ($1, 'b.png', '/media/b.png', 'image/png', 5242880, 'pending_deletion', true)`,
      [worldId]
    );
    // One asset with missing file — does NOT count.
    await pool.query(
      `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, lifecycle, file_confirmed_present)
       VALUES ($1, 'c.png', '/media/c.png', 'image/png', 1048576, 'active', false)`,
      [worldId]
    );
    // One active reservation (2 MB).
    await pool.query(
      `INSERT INTO storage_reservations (world_id, size_bytes, state, expires_at)
       VALUES ($1, 2097152, 'RESERVED', now() + interval '5 minutes')`,
      [worldId]
    );
    // One committed reservation — does NOT count.
    await pool.query(
      `INSERT INTO storage_reservations (world_id, size_bytes, state, expires_at, released_at)
       VALUES ($1, 2097152, 'COMMITTED', now() + interval '5 minutes', now())`,
      [worldId]
    );

    const r = await pool.query(`SELECT quota_used_bytes($1) AS total`, [worldId]);
    // 10 + 5 + 2 = 17 MB. Missing-file (1 MB) and committed (2 MB) excluded.
    expect(Number(r.rows[0].total)).toBe(10485760 + 5242880 + 2097152);
  });
});

describe('QUOTA-1: config parsing', () => {
  it('defaults to 50 MB when unset', async () => {
    const { getWorldQuotaBytes } = await import('../../src/shared/config/quota.js');
    const orig = process.env.MEDIA_WORLD_QUOTA_MB;
    delete process.env.MEDIA_WORLD_QUOTA_MB;
    try {
      expect(getWorldQuotaBytes()).toBe(50 * 1024 * 1024);
    } finally {
      if (orig !== undefined) process.env.MEDIA_WORLD_QUOTA_MB = orig;
    }
  });

  it('accepts valid override', async () => {
    const { getWorldQuotaBytes } = await import('../../src/shared/config/quota.js');
    const orig = process.env.MEDIA_WORLD_QUOTA_MB;
    process.env.MEDIA_WORLD_QUOTA_MB = '100';
    try {
      expect(getWorldQuotaBytes()).toBe(100 * 1024 * 1024);
    } finally {
      if (orig !== undefined) process.env.MEDIA_WORLD_QUOTA_MB = orig;
      else delete process.env.MEDIA_WORLD_QUOTA_MB;
    }
  });

  it.each(['0', '-5', '50abc', '1.5', '', ' 50 ', '\t50', '1000001'])(
    'rejects invalid value %s',
    async (val) => {
      const { getWorldQuotaBytes, QuotaConfigError } = await import(
        '../../src/shared/config/quota.js'
      );
      const orig = process.env.MEDIA_WORLD_QUOTA_MB;
      process.env.MEDIA_WORLD_QUOTA_MB = val;
      try {
        expect(() => getWorldQuotaBytes()).toThrow(QuotaConfigError);
      } finally {
        if (orig !== undefined) process.env.MEDIA_WORLD_QUOTA_MB = orig;
        else delete process.env.MEDIA_WORLD_QUOTA_MB;
      }
    }
  );
});

describe('QUOTA-1: file size limit', () => {
  it('allows exactly 10 MB', async () => {
    const { checkFileSizeLimit } = await import('../../src/shared/config/quota.js');
    expect(() => checkFileSizeLimit(10 * 1024 * 1024)).not.toThrow();
  });

  it('rejects over 10 MB with 413', async () => {
    const { checkFileSizeLimit, QuotaError } = await import('../../src/shared/config/quota.js');
    try {
      checkFileSizeLimit(10 * 1024 * 1024 + 1);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaError);
      expect((err as QuotaError).code).toBe('FILE_TOO_LARGE');
      expect((err as QuotaError).httpStatus).toBe(413);
    }
  });
});

describe('QUOTA-1: atomic handoff', () => {
  it('commits reservation and inserts PENDING asset atomically', async () => {
    const { commitReservationToRegistry, noopHandoffMetrics } = await import(
      '../../src/modules/world/domain/services/quota-handoff.service.js'
    );

    const worldId = '22222222-2222-2222-2222-222222222222';
    const rid = (
      await pool.query(
        `INSERT INTO storage_reservations (world_id, size_bytes, state, expires_at)
         VALUES ($1, 1048576, 'RESERVED', now() + interval '5 minutes')
         RETURNING reservation_id`,
        [worldId]
      )
    ).rows[0].reservation_id;

    const deps = {
      withTransaction,
      log: () => {},
      metrics: noopHandoffMetrics(),
    };

    const fname = `test-${randomUUID()}.png`;
    const { assetId } = await commitReservationToRegistry(
      {
        reservationId: rid,
        worldId,
        filename: fname,
        url: `/media/${fname}`,
        mimetype: 'image/png',
        sizeBytes: 1048576,
        contentSha256: 'a'.repeat(64),
      },
      deps
    );

    expect(assetId).toBeTruthy();

    // Reservation is COMMITTED.
    const res = await pool.query(`SELECT state FROM storage_reservations WHERE reservation_id=$1`, [rid]);
    expect(res.rows[0].state).toBe('COMMITTED');

    // Asset is PENDING with reservation link.
    const asset = await pool.query(
      `SELECT publication_status, reservation_id, content_sha256, lifecycle FROM world_media_assets WHERE asset_id=$1`,
      [assetId]
    );
    expect(asset.rows[0].publication_status).toBe('PENDING');
    expect(asset.rows[0].reservation_id).toBe(rid);
    expect(asset.rows[0].content_sha256).toBe('a'.repeat(64));
    expect(asset.rows[0].lifecycle).toBe('active');
  });

  it('rejects world mismatch with 403', async () => {
    const { commitReservationToRegistry, noopHandoffMetrics } = await import(
      '../../src/modules/world/domain/services/quota-handoff.service.js'
    );
    const { QuotaError } = await import('../../src/shared/config/quota.js');

    const worldId = '22222222-2222-2222-2222-222222222222';
    const otherWorld = '33333333-3333-3333-3333-333333333333';
    const rid = (
      await pool.query(
        `INSERT INTO storage_reservations (world_id, size_bytes, state, expires_at)
         VALUES ($1, 1048576, 'RESERVED', now() + interval '5 minutes')
         RETURNING reservation_id`,
        [worldId]
      )
    ).rows[0].reservation_id;

    const deps = { withTransaction, log: () => {}, metrics: noopHandoffMetrics() };

    try {
      await commitReservationToRegistry(
        {
          reservationId: rid,
          worldId: otherWorld, // Wrong world!
          filename: `x-${randomUUID()}.png`,
          url: `/media/x-${randomUUID()}.png`,
          mimetype: 'image/png',
          sizeBytes: 1048576,
          contentSha256: 'b'.repeat(64),
        },
        deps
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaError);
      expect((err as QuotaError).code).toBe('WORLD_MISMATCH');
      expect((err as QuotaError).httpStatus).toBe(403);
    }

    // Reservation unchanged.
    const res = await pool.query(`SELECT state FROM storage_reservations WHERE reservation_id=$1`, [rid]);
    expect(res.rows[0].state).toBe('RESERVED');
  });

  it('concurrent handoffs: exactly one wins', async () => {
    const { commitReservationToRegistry, noopHandoffMetrics } = await import(
      '../../src/modules/world/domain/services/quota-handoff.service.js'
    );

    const worldId = '22222222-2222-2222-2222-222222222222';
    const rid = (
      await pool.query(
        `INSERT INTO storage_reservations (world_id, size_bytes, state, expires_at)
         VALUES ($1, 1048576, 'RESERVED', now() + interval '5 minutes')
         RETURNING reservation_id`,
        [worldId]
      )
    ).rows[0].reservation_id;

    const deps = { withTransaction, log: () => {}, metrics: noopHandoffMetrics() };
    const input = {
      reservationId: rid,
      worldId,
      filename: `race-${randomUUID()}.png`,
      url: `/media/race-${randomUUID()}.png`,
      mimetype: 'image/png',
      sizeBytes: 1048576,
      contentSha256: 'c'.repeat(64),
    };

    const results = await Promise.allSettled([
      commitReservationToRegistry(input, deps),
      commitReservationToRegistry({ ...input, filename: `race2-${randomUUID()}.png`, url: `/media/race2-${randomUUID()}.png` }, deps),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);

    // Exactly one asset row.
    const count = await pool.query(
      `SELECT COUNT(*) AS n FROM world_media_assets WHERE reservation_id=$1`,
      [rid]
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });
});

describe('QUOTA-1: handoff metrics', () => {
  it('B4: committed metric not incremented if transaction fails to commit', async () => {
    const { commitReservationToRegistry } = await import(
      '../../src/modules/world/domain/services/quota-handoff.service.js'
    );
    const { createWorkerMetrics } = await import(
      '../../src/shared/metrics/worker-metrics.js'
    );

    const worldId = '22222222-2222-2222-2222-222222222222';
    const rid = (
      await pool.query(
        `INSERT INTO storage_reservations (world_id, size_bytes, state, expires_at)
         VALUES ($1, 1048576, 'RESERVED', now() + interval '5 minutes')
         RETURNING reservation_id`,
        [worldId]
      )
    ).rows[0].reservation_id;

    const m = createWorkerMetrics();
    // Extend with handoff counter.
    (m as any).handoffTotal = { inc: () => {}, get: () => 0 };
    let handoffCount = 0;

    const flakyWithTransaction = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('ROLLBACK'); // Simulate commit failure.
        throw new Error('simulated commit failure');
      } finally {
        client.release();
      }
    };

    const deps = {
      withTransaction: flakyWithTransaction,
      log: () => {},
      metrics: {
        handoffTotal: { inc: (_labels: { outcome: string }) => { handoffCount++; } },
      },
    };

    await expect(
      commitReservationToRegistry(
        {
          reservationId: rid,
          worldId,
          filename: `x-${randomUUID()}.png`,
          url: `/media/x-${randomUUID()}.png`,
          mimetype: 'image/png',
          sizeBytes: 1048576,
          contentSha256: 'd'.repeat(64),
        },
        deps
      )
    ).rejects.toThrow('simulated commit failure');

    // 'committed' must NOT have been recorded (only 'error' for the failure).
    // handoffCount should be 1 (the error outcome), not 2.
    expect(handoffCount).toBe(1);
  });
});

describe('QUOTA-1: schema verification', () => {
  it('passes when all eight columns exist', async () => {
    const { verifyQuotaSchema } = await import('../../src/shared/config/quota.js');
    await expect(
      verifyQuotaSchema(async (sql) => {
        const r = await pool.query(sql);
        return { rows: r.rows as Array<Record<string, unknown>> };
      })
    ).resolves.not.toThrow();
  });

  // B3: Eight individual missing-column cases, each naming the missing pair.
  const allColumns = [
    { table: 'world_media_assets', column: 'lifecycle' },
    { table: 'world_media_assets', column: 'file_confirmed_present' },
    { table: 'world_media_assets', column: 'size_bytes' },
    { table: 'world_media_assets', column: 'publication_status' },
    { table: 'world_media_assets', column: 'reservation_id' },
    { table: 'world_media_assets', column: 'content_sha256' },
    { table: 'storage_reservations', column: 'state' },
    { table: 'storage_reservations', column: 'size_bytes' },
  ];

  it.each(allColumns)('fails when $table.$column is missing', async ({ table, column }) => {
    const { verifyQuotaSchema, QuotaConfigError } = await import(
      '../../src/shared/config/quota.js'
    );
    const rows = allColumns
      .filter((c) => !(c.table === table && c.column === column))
      .map((c) => ({ table_name: c.table, column_name: c.column }));
    const fakeQuery = async () => ({ rows: rows as Array<Record<string, unknown>> });
    await expect(verifyQuotaSchema(fakeQuery)).rejects.toThrow(QuotaConfigError);
    await expect(verifyQuotaSchema(fakeQuery)).rejects.toThrow(/QUOTA_SCHEMA_INCOMPLETE/);
    await expect(verifyQuotaSchema(fakeQuery)).rejects.toThrow(new RegExp(`${table}\\.${column}`));
  });
});
