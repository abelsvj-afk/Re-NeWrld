import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../scripts/migrate.js';
import { setPool, closePool, query, withTransaction, pool } from '../../src/shared/database/db.js';
import { PostgresStorageReservationRepository } from '../../src/modules/world/infrastructure/persistence/postgres-storage-reservation.repository.js';
import {
  lockWorldRowForUpdate,
  isFenceActive,
  activateFence,
  deactivateFence,
  getCapacityMetric,
} from '../../src/modules/world/infrastructure/persistence/postgres-reserve-storage.adapter.js';
import {
  reserveStorage,
  ReserveStorageDeps,
  CapacityMetric,
} from '../../src/modules/world/domain/services/reserve-storage.service.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import crypto from 'node:crypto';
import type pkg from 'pg';

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

describeFn('RES-1a Phase-1 check-and-reserve (integration)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let repository: PostgresStorageReservationRepository;

  const QUOTA_BYTES = 50 * 1024 * 1024;
  const NARRATION_RESERVE = 1024 * 1024 * 1024;
  const CAPACITY_BYTES = Math.round(2.5 * 1024 * 1024 * 1024);

  /** Seed the capacity metric table with a fresh measurement. */
  async function seedMetric(overrides: Partial<CapacityMetric> = {}): Promise<void> {
    const m: CapacityMetric = {
      storageCapacityBytes: CAPACITY_BYTES,
      storageUsedBytes: 0,
      activeReservationsAtMeasureTime: 0,
      narrationBytes: 100 * 1024 * 1024,
      measuredAt: new Date(),
      ...overrides,
    };
    await query(
      `INSERT INTO storage_capacity_metrics
         (storage_capacity_bytes, storage_used_bytes, active_reservations_at_measure_time,
          narration_bytes, measured_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        m.storageCapacityBytes,
        m.storageUsedBytes,
        m.activeReservationsAtMeasureTime,
        m.narrationBytes,
        m.measuredAt,
      ]
    );
  }

  /** Create a real world row (with a creator user for the FK). Returns the WorldId. */
  async function createWorld(): Promise<WorldId> {
    const userId = crypto.randomUUID();
    await query(
      `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [userId, `test-${userId}@example.com`, 'hash', 'creator']
    );
    const worldId = crypto.randomUUID();
    await query(
      `INSERT INTO worlds (world_id, creator_id, title) VALUES ($1, $2, $3)`,
      [worldId, userId, 'Test World']
    );
    return new WorldId(worldId);
  }

  function makeDeps(): ReserveStorageDeps {
    return {
      reservationRepository: repository,
      getCapacityMetric,
      isFenceActive,
      lockWorldRow: lockWorldRowForUpdate,
      quotaBytes: QUOTA_BYTES,
      narrationReserveBytes: NARRATION_RESERVE,
      metricMaxAgeMs: 5 * 60 * 1000,
      // QUOTA-1 B1: single quota definition via SQL function.
      quotaUsedBytes: async (worldId: any, tx: any) => {
        const id = typeof worldId === 'string' ? worldId : worldId.getValue();
        const r = await tx.query(`SELECT quota_used_bytes($1) AS total`, [id]);
        return Number(r.rows[0].total);
      },
    };
  }

  beforeAll(async () => {
    const externalUrl = process.env.TEST_DATABASE_URL;
    let connectionString: string;
    if (externalUrl) {
      connectionString = externalUrl;
      setPool(externalUrl);
    } else {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      connectionString = container.getConnectionUri();
      setPool(connectionString);
    }
    await runMigrations(connectionString);
    // Capacity metric table (owned by the monitoring slice; created here for RES-1a tests).
    await query(`
      CREATE TABLE IF NOT EXISTS storage_capacity_metrics (
        id SERIAL PRIMARY KEY,
        storage_capacity_bytes BIGINT NOT NULL,
        storage_used_bytes BIGINT NOT NULL,
        active_reservations_at_measure_time BIGINT NOT NULL,
        narration_bytes BIGINT,
        measured_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    repository = new PostgresStorageReservationRepository();
  }, 120000);

  afterAll(async () => {
    await closePool();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await query(`DELETE FROM storage_reservations`);
    await query(`DELETE FROM storage_capacity_metrics`);
    await query(`DELETE FROM world_media_assets`);
    await query(`UPDATE system_maintenance SET active = false WHERE id = 1`);
    await seedMetric();
  });

  it('creates a RESERVED reservation on the happy path', async () => {
    const worldId = await createWorld();
    const r = await reserveStorage(worldId, 1024 * 1024, makeDeps());

    expect(r.state).toBe('RESERVED');
    expect(r.releasedAt).toBeNull();
    expect(r.sizeBytes).toBe(1024 * 1024);
    const skew = r.expiresAt.getTime() - Date.now() - 5 * 60 * 1000;
    expect(Math.abs(skew)).toBeLessThan(60000);
  });

  it('rejects when the world quota would be exceeded', async () => {
    const worldId = await createWorld();
    // Seed registered bytes near quota via a committed asset row.
    await query(
      `INSERT INTO world_media_assets
         (asset_id, world_id, filename, url, mimetype, size_bytes, file_confirmed_present)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [crypto.randomUUID(), worldId.getValue(), `q-${crypto.randomUUID()}.png`, '/media/q.png', 'image/png', QUOTA_BYTES - 100]
    );

    await expect(reserveStorage(worldId, 200, makeDeps())).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      httpStatus: 507,
    });
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
  });

  it('allows exact-boundary admission and rejects one byte over', async () => {
    const worldId = await createWorld();
    const r = await reserveStorage(worldId, QUOTA_BYTES, makeDeps());
    expect(r.state).toBe('RESERVED');

    const w2 = await createWorld();
    await expect(reserveStorage(w2, QUOTA_BYTES + 1, makeDeps())).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('concurrent same-world requests: exactly one succeeds when combined exceeds quota', async () => {
    // Two concurrent Phase-1s for the SAME world, each requesting 60% of quota.
    // Only one can succeed (60% + 60% > 100%).
    const worldId = await createWorld();
    const size = Math.floor(QUOTA_BYTES * 0.6);

    const results = await Promise.allSettled([
      reserveStorage(worldId, size, makeDeps()),
      reserveStorage(worldId, size, makeDeps()),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    // Exactly one reservation row exists.
    expect(await repository.sumActiveBytes(worldId)).toBe(size);
  });

  it('second transaction sees the first committed reservation (S5-partial)', async () => {
    const worldId = await createWorld();
    const deps = makeDeps();
    await reserveStorage(worldId, QUOTA_BYTES / 2, deps);
    await expect(reserveStorage(worldId, QUOTA_BYTES / 2 + 1, deps)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('rejects when physical capacity is insufficient (S38)', async () => {
    const worldId = await createWorld();
    await query(`DELETE FROM storage_capacity_metrics`);
    await seedMetric({ storageCapacityBytes: 1000, storageUsedBytes: 600 });

    await expect(reserveStorage(worldId, 500, makeDeps())).rejects.toMatchObject({
      code: 'STORAGE_FULL',
      httpStatus: 507,
    });
  });

  it('concurrent different-world requests respect shared capacity (S38)', async () => {
    const w1 = await createWorld();
    const w2 = await createWorld();
    await query(`DELETE FROM storage_capacity_metrics`);
    await seedMetric({ storageCapacityBytes: 1500, storageUsedBytes: 0 });

    const results = await Promise.allSettled([
      reserveStorage(w1, 1000, makeDeps()),
      reserveStorage(w2, 1000, makeDeps()),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(1);
    expect(await repository.sumActiveBytes()).toBeLessThanOrEqual(1500);
  });

  it('rejects on stale metric and on narration reserve breach (fail-closed)', async () => {
    const worldId = await createWorld();

    await query(`DELETE FROM storage_capacity_metrics`);
    await seedMetric({ measuredAt: new Date(Date.now() - 10 * 60 * 1000) });
    await expect(reserveStorage(worldId, 1000, makeDeps())).rejects.toMatchObject({
      code: 'STORAGE_METRIC_STALE',
      httpStatus: 503,
    });

    await query(`DELETE FROM storage_capacity_metrics`);
    await seedMetric({ narrationBytes: NARRATION_RESERVE });
    await expect(reserveStorage(worldId, 1000, makeDeps())).rejects.toMatchObject({
      code: 'NARRATION_CAPACITY_EXCEEDED',
      httpStatus: 503,
    });
  });

  it('rejects when the fence is active (before L2/L3)', async () => {
    const worldId = await createWorld();
    await withTransaction(async (tx) => {
      await activateFence(tx, 'test');
    });

    await expect(reserveStorage(worldId, 1000, makeDeps())).rejects.toMatchObject({
      code: 'FENCE_ACTIVE',
      httpStatus: 503,
    });
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
  });

  /**
   * Poll pg_locks until the specified backend is waiting on the L1 advisory
   * lock (media_global). Filters by PID and lock key — not just any waiter.
   * Deterministic: waits for real database state, not a timer.
   */
  async function waitForL1Waiter(pid: number, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await query(
        `SELECT count(*) AS n FROM pg_locks
         WHERE locktype = 'advisory'
           AND pid = $1
           AND NOT granted
           AND classid = 4294967295
           AND objid = ((hashtext('media_global')::bigint + 4294967296) % 4294967296)::oid
           AND objsubid = 1`,
        [pid]
      );
      if (Number(r.rows[0].n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for PID ${pid} to wait on the L1 advisory lock`);
  }

  /**
   * Poll pg_locks until the specified backend is waiting on a transaction ID
   * (i.e., blocked on another transaction's row lock). Filters by PID.
   */
  async function waitForTxWaiter(pid: number, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await query(
        `SELECT count(*) AS n FROM pg_locks
         WHERE locktype = 'transactionid' AND NOT granted AND pid = $1`,
        [pid]
      );
      if (Number(r.rows[0].n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for PID ${pid} to wait on a transaction ID`);
  }

  it('fence-wins race: fence holds L1, real reserveStorage() blocks then rejects', async () => {
    // Fully deterministic: the fence signals when it holds L1; Phase-1 then
    // starts and its PID is captured via the hook; we prove THAT backend waits
    // on the specific L1 lock key before the fence commits. No timing.
    const worldId = await createWorld();

    let phase1Pid = 0;
    let fenceHoldsL1!: () => void;
    const fenceHasL1 = new Promise<void>((resolve) => {
      fenceHoldsL1 = resolve;
    });
    let pidCaptured!: () => void;
    const pidIsCaptured = new Promise<void>((resolve) => {
      pidCaptured = resolve;
    });

    const fenceTx = withTransaction(async (tx: pkg.PoolClient) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
      fenceHoldsL1();
      // Wait for Phase-1 to capture its PID, then prove it's blocked on L1.
      await pidIsCaptured;
      await waitForL1Waiter(phase1Pid);
      await tx.query(`UPDATE system_maintenance SET active = true WHERE id = 1`);
      // COMMIT releases L1; Phase-1 acquires it, sees the fence, rejects.
    });

    const phase1Tx = (async () => {
      await fenceHasL1; // Deterministic: fence holds L1 before we attempt it.
      const deps = makeDeps();
      let l2l3Acquired = false;
      const origLock = deps.lockWorldRow;
      deps.lockWorldRow = async (wid, tx) => {
        l2l3Acquired = true;
        return origLock(wid, tx);
      };
      deps.testHooks = {
        onBeforeL1Attempt: async (pid: number) => {
          phase1Pid = pid;
          pidCaptured();
          // Return immediately; the L1 acquisition attempt blocks next.
        },
      };
      try {
        await reserveStorage(worldId, 1000, deps);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: e, l2l3Acquired };
      }
    })();

    const [, phase1Result] = await Promise.all([fenceTx, phase1Tx]);

    expect(phase1Result.ok).toBe(false);
    if (!phase1Result.ok) {
      expect(phase1Result.error).toMatchObject({ code: 'FENCE_ACTIVE' });
      expect(phase1Result.l2l3Acquired).toBe(false);
    }
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
    await withTransaction(deactivateFence);
  });

  it('Phase-1-wins race: real reserveStorage() commits before fence activation', async () => {
    // Real `reserveStorage()` signals via the test hook while holding L1.
    // Fence activation starts on a second connection; we capture its PID and
    // prove THAT backend waits on the specific L1 key before releasing Phase-1.
    const worldId = await createWorld();

    let releasePhase1!: () => void;
    const phase1MayProceed = new Promise<void>((resolve) => {
      releasePhase1 = resolve;
    });
    let hookSignaled!: () => void;
    const hookFired = new Promise<void>((resolve) => {
      hookSignaled = resolve;
    });

    const deps = makeDeps();
    deps.testHooks = {
      onL1Acquired: async (_pid: number) => {
        hookSignaled();
        await phase1MayProceed;
      },
    };

    const phase1Tx = reserveStorage(worldId, 1000, deps);

    // Wait for Phase-1 to hold L1, then start fence activation.
    await hookFired;
    let fencePid = 0;
    const fenceTx = withTransaction(async (tx: pkg.PoolClient) => {
      const r = await tx.query(`SELECT pg_backend_pid() AS pid`);
      fencePid = Number(r.rows[0].pid);
      await activateFence(tx, 'race-test');
    });
    // Wait for the fence backend to start, then prove it's waiting on L1.
    // Poll until fencePid is set, then wait for the specific waiter.
    const start = Date.now();
    while (fencePid === 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fencePid).not.toBe(0);
    await waitForL1Waiter(fencePid);
    // Release Phase-1 to complete its reservation and commit.
    releasePhase1();

    const [reservation] = await Promise.all([phase1Tx, fenceTx]);

    expect(reservation.state).toBe('RESERVED');
    const found = await repository.findById(reservation.reservationId);
    expect(found?.state).toBe('RESERVED');
    const active = await query(`SELECT active FROM system_maintenance WHERE id = 1`);
    expect(active.rows[0].active).toBe(true);

    await withTransaction(deactivateFence);
  });

  it('L3 uses a real FOR UPDATE row lock; missing world throws', async () => {
    const fakeId = new WorldId(crypto.randomUUID());
    await expect(
      withTransaction((tx) => lockWorldRowForUpdate(fakeId, tx))
    ).rejects.toThrow(/world not found/);

    // Real world: verify FOR UPDATE blocks a concurrent locker.
    // We capture tx2's PID and prove THAT backend waits on a transaction ID.
    const worldId = await createWorld();

    const client1 = await pool.connect();
    await client1.query('BEGIN');
    await lockWorldRowForUpdate(worldId, client1);

    let tx2Pid = 0;
    let tx2Done = false;
    const tx2Promise = (async () => {
      await withTransaction(async (tx: pkg.PoolClient) => {
        const r = await tx.query(`SELECT pg_backend_pid() AS pid`);
        tx2Pid = Number(r.rows[0].pid);
        await lockWorldRowForUpdate(worldId, tx);
      });
      tx2Done = true;
    })();

    // Wait for tx2's PID to be captured, then prove it's waiting.
    const start = Date.now();
    while (tx2Pid === 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(tx2Pid).not.toBe(0);
    await waitForTxWaiter(tx2Pid);
    expect(tx2Done).toBe(false);

    // Prove the blocker relationship: tx1's PID must be blocking tx2.
    // Capture tx1's PID from its client connection.
    const tx1PidResult = await client1.query(`SELECT pg_backend_pid() AS pid`);
    const tx1Pid = Number(tx1PidResult.rows[0].pid);
    const blockingResult = await query(
      `SELECT pg_blocking_pids($1) AS blockers`,
      [tx2Pid]
    );
    const blockers: number[] = blockingResult.rows[0].blockers;
    expect(blockers).toContain(tx1Pid);

    await client1.query('COMMIT');
    client1.release();
    await tx2Promise;
    expect(tx2Done).toBe(true);
  });

  it('rolls back cleanly on DB failure (no partial row, locks released)', async () => {
    const worldId = await createWorld();
    const deps = makeDeps();
    const origCreate = repository.create.bind(repository);
    (repository as { create: unknown }).create = async () => {
      throw new Error('simulated DB failure');
    };
    try {
      await expect(reserveStorage(worldId, 1000, deps)).rejects.toThrow('simulated DB failure');
    } finally {
      repository.create = origCreate;
    }
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
    // Locks released: a subsequent reservation succeeds.
    const r = await reserveStorage(worldId, 1000, makeDeps());
    expect(r.state).toBe('RESERVED');
  });

  it('validates sizeBytes', async () => {
    const worldId = await createWorld();
    await expect(reserveStorage(worldId, 0, makeDeps())).rejects.toThrow();
    await expect(reserveStorage(worldId, -5, makeDeps())).rejects.toThrow();
  });
});
