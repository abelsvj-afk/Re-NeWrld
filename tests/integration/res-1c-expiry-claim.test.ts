/**
 * RES-1c Expiry Claim Worker tests (design §7.1–§7.11).
 *
 * Run with: TEST_DATABASE_URL=... DATABASE_URL=... npx vitest run tests/integration/res-1c-expiry-claim.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

let pool: pkg.Pool;
let mediaRoot: string;

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

async function makeDeps() {
  const { noopMetrics } = await import(
    '../../src/modules/world/domain/services/expiry-claim.service.js'
  );
  return {
    mediaRoot,
    withTransaction,
    query: async (sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount };
    },
    log: () => {},
    metrics: noopMetrics(),
  };
}

async function createReservation(expiresAgoSeconds: number = 60): Promise<string> {
  const worldId = '11111111-1111-1111-1111-111111111111';
  const r = await pool.query(
    `INSERT INTO storage_reservations (world_id, size_bytes, state, expires_at)
     VALUES ($1, 10485760, 'RESERVED', now() - ($2 || ' seconds')::interval)
     RETURNING reservation_id`,
    [worldId, String(expiresAgoSeconds)],
  );
  return r.rows[0].reservation_id;
}

beforeAll(async () => {
  pool = new pkg.Pool({ connectionString: TEST_DATABASE_URL });
  mediaRoot = await mkdtemp(join(tmpdir(), 'res1c-test-'));
  await mkdir(join(mediaRoot, '.tmp'), { recursive: true });

  const { readFile, readdir } = await import('node:fs/promises');
  const migDir = join(process.cwd(), 'db/migrations');
  const files = (await readdir(migDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const mig of files) {
    const sql = await readFile(join(migDir, mig), 'utf-8');
    await pool.query(sql);
  }

  // Create test world.
  const userId = '00000000-0000-0000-0000-000000000000';
  await pool.query(
    `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, 'test@test.com', 'hash', 'creator') ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  await pool.query(
    `INSERT INTO worlds (world_id, title, creator_id) VALUES ('11111111-1111-1111-1111-111111111111', 'Test', $1) ON CONFLICT (world_id) DO NOTHING`,
    [userId],
  );
});

afterAll(async () => {
  if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
  await pool.end();
});

describe('RES-1c Expiry Claim (§7)', () => {
  it('§7.1: crashed writer is claimed', async () => {
    const { claimOne, discoverCandidates } = await import(
      '../../src/modules/world/domain/services/expiry-claim.service.js'
    );
    const { tempPathFor, lockPathFor } = await import(
      '../../src/modules/world/domain/services/phase2-writer.service.js'
    );

    const rid = await createReservation(120); // Expired 2 min ago.
    // Simulate crashed writer's temp file.
    await writeFile(tempPathFor(mediaRoot, rid), Buffer.alloc(1024));

    const candidates = await discoverCandidates((await makeDeps()));
    expect(candidates.map((c) => c.reservation_id)).toContain(rid);

    const result = await claimOne(
      candidates.find((c) => c.reservation_id === rid)!,
      (await makeDeps()),
    );
    expect(result).toBe('claimed');

    const after = await pool.query(
      `SELECT state, released_at, claim_epoch FROM storage_reservations WHERE reservation_id=$1`,
      [rid],
    );
    expect(after.rows[0].state).toBe('ABANDONED');
    expect(after.rows[0].released_at).not.toBeNull();
    expect(Number(after.rows[0].claim_epoch)).toBe(0);

    // Temp file cleaned up; lock file preserved.
    const { stat } = await import('node:fs/promises');
    await expect(stat(tempPathFor(mediaRoot, rid))).rejects.toThrow();
    const lockStat = await stat(lockPathFor(mediaRoot, rid));
    expect(lockStat.isFile()).toBe(true);
  });

  it('§7.2: live writer is NOT claimed (lock held)', async () => {
    const { claimOne, discoverCandidates } = await import(
      '../../src/modules/world/domain/services/expiry-claim.service.js'
    );
    const {
      acquireExclusiveNonBlocking,
      releaseLock,
    } = await import('../../src/shared/fs/flock.js');

    const rid = await createReservation(120);
    const { lockPathFor } = await import(
      '../../src/modules/world/domain/services/phase2-writer.service.js'
    );
    // Simulate live writer holding the ownership lock.
    const lock = await acquireExclusiveNonBlocking(lockPathFor(mediaRoot, rid));
    try {
      const candidates = await discoverCandidates((await makeDeps()));
      const candidate = candidates.find((c) => c.reservation_id === rid)!;
      const result = await claimOne(candidate, (await makeDeps()));
      expect(result).toBe('skipped');

      const after = await pool.query(
        `SELECT state FROM storage_reservations WHERE reservation_id=$1`,
        [rid],
      );
      expect(after.rows[0].state).toBe('RESERVED');
    } finally {
      await releaseLock(lock);
    }
  });

  it('§7.4: stale epoch → CAS gets 0 rows', async () => {
    const { claimOne } = await import(
      '../../src/modules/world/domain/services/expiry-claim.service.js'
    );

    const rid = await createReservation(120);
    // Simulate heartbeat advancing epoch.
    await pool.query(
      `UPDATE storage_reservations SET epoch = epoch + 1 WHERE reservation_id=$1`,
      [rid],
    );

    // Claim with stale epoch 0.
    const result = await claimOne(
      { reservation_id: rid, epoch: 0, world_id: 'w', size_bytes: 100 },
      (await makeDeps()),
    );
    expect(result).toBe('skipped');

    const after = await pool.query(
      `SELECT state FROM storage_reservations WHERE reservation_id=$1`,
      [rid],
    );
    expect(after.rows[0].state).toBe('RESERVED');
  });

  it('§7.5: quota released atomically', async () => {
    const { claimOne, discoverCandidates } = await import(
      '../../src/modules/world/domain/services/expiry-claim.service.js'
    );

    const rid = await createReservation(120);
    const worldId = '11111111-1111-1111-1111-111111111111';

    const sumActive = async () => {
      const r = await pool.query(
        `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM storage_reservations WHERE world_id=$1 AND released_at IS NULL`,
        [worldId],
      );
      return Number(r.rows[0].total);
    };

    const before = await sumActive();
    const candidates = await discoverCandidates((await makeDeps()));
    await claimOne(candidates.find((c) => c.reservation_id === rid)!, (await makeDeps()));
    const after = await sumActive();

    // The claimed reservation's bytes are no longer in active accounting.
    // (before includes bytes from other tests' reservations in this world;
    // we assert the delta is exactly our reservation's size.)
    expect(before - after).toBe(10485760);
  });

  it('§7.6: observation window respected', async () => {
    const { discoverCandidates } = await import(
      '../../src/modules/world/domain/services/expiry-claim.service.js'
    );

    const rid = await createReservation(10); // Only 10s expired (< 30s window).
    const candidates = await discoverCandidates((await makeDeps()));
    expect(candidates.map((c) => c.reservation_id)).not.toContain(rid);
  });

  it('§7.10: two workers cannot double-claim the SAME reservation', async () => {
    const { claimOne, discoverCandidates } = await import(
      '../../src/modules/world/domain/services/expiry-claim.service.js'
    );

    const rid = await createReservation(120);
    const deps = (await makeDeps());
    const candidates = await discoverCandidates(deps);
    const candidate = candidates.find((c) => c.reservation_id === rid)!;
    expect(candidate).toBeTruthy();

    // B1: Give the SAME candidate to two concurrent claimOne() calls.
    // Exactly one must win (claimed); the other must lose (skipped).
    const [r1, r2] = await Promise.all([
      claimOne(candidate, deps),
      claimOne(candidate, deps),
    ]);

    const claimedCount = [r1, r2].filter((r) => r === 'claimed').length;
    const skippedCount = [r1, r2].filter((r) => r === 'skipped').length;
    expect(claimedCount).toBe(1);
    expect(skippedCount).toBe(1);

    const after = await pool.query(
      `SELECT state, released_at, claim_epoch, claim_finalized_at
         FROM storage_reservations WHERE reservation_id=$1`,
      [rid],
    );
    expect(after.rows[0].state).toBe('ABANDONED');
    expect(after.rows[0].released_at).not.toBeNull();
    expect(after.rows[0].claim_epoch).not.toBeNull();
    expect(after.rows[0].claim_finalized_at).not.toBeNull();
  });

  it('B2: metrics are incremented on claim/skip', async () => {
    const { claimOne, discoverCandidates } = await import(
      '../../src/modules/world/domain/services/expiry-claim.service.js'
    );
    const { createWorkerMetrics } = await import(
      '../../src/shared/metrics/worker-metrics.js'
    );

    const m = createWorkerMetrics();
    const deps = {
      ...(await makeDeps()),
      metrics: {
        claimsTotal: { inc: () => m.expiryClaimsTotal.inc() },
        skipsTotal: { inc: () => m.expiryClaimSkipsTotal.inc() },
        errorsTotal: { inc: () => m.expiryClaimErrorsTotal.inc() },
      },
    };

    const rid1 = await createReservation(120);
    const candidates = await discoverCandidates(deps);
    const c1 = candidates.find((c) => c.reservation_id === rid1)!;
    expect(c1).toBeTruthy();

    const r1 = await claimOne(c1, deps);
    expect(r1).toBe('claimed');
    expect(m.expiryClaimsTotal.get()).toBe(1);

    const r2 = await claimOne(c1, deps);
    expect(r2).toBe('skipped');
    expect(m.expiryClaimSkipsTotal.get()).toBe(1);
    expect(m.expiryClaimErrorsTotal.get()).toBe(0);
  });

  it('B2: worker metrics singleton is usable', async () => {
    const { getWorkerMetrics } = await import(
      '../../src/shared/metrics/worker-metrics.js'
    );
    const wm = getWorkerMetrics();
    expect(typeof wm.expiryClaimsTotal.get()).toBe('number');
    expect(typeof wm.expiryClaimSkipsTotal.get()).toBe('number');
    expect(typeof wm.expiryClaimErrorsTotal.get()).toBe('number');
    expect(typeof wm.deliverySentTotal.get()).toBe('number');
    expect(typeof wm.deliveryFailedTotal.get()).toBe('number');
  });
});
