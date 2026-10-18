import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../scripts/migrate.js';
import { setPool, closePool, query, withTransaction } from '../../src/shared/database/db.js';
import { PostgresStorageReservationRepository } from '../../src/modules/world/infrastructure/persistence/postgres-storage-reservation.repository.js';
import {
  lockWorldRowForUpdate,
  isFenceActive,
  activateFence,
  deactivateFence,
  getRegisteredBytes,
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
      getRegisteredBytes,
      lockWorldRow: lockWorldRowForUpdate,
      quotaBytes: QUOTA_BYTES,
      narrationReserveBytes: NARRATION_RESERVE,
      metricMaxAgeMs: 5 * 60 * 1000,
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
      [crypto.randomUUID(), worldId.getValue(), 'a.png', '/media/a.png', 'image/png', QUOTA_BYTES - 100]
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

  it('fence-wins race: fence commits first, Phase-1 blocks on L1 then rejects', async () => {
    // Two real concurrent transactions serialized by the L1 advisory lock.
    // Fence activation acquires L1 first and commits; Phase-1 then observes
    // the active fence and rejects before acquiring L2/L3.
    const worldId = await createWorld();

    // Barrier: fence transaction signals when it holds L1.
    let fenceHoldsL1!: () => void;
    const fenceHasL1 = new Promise<void>((resolve) => {
      fenceHoldsL1 = resolve;
    });
    // Barrier: Phase-1 signals when it starts waiting for L1.
    let phase1Waiting!: () => void;
    const phase1IsWaiting = new Promise<void>((resolve) => {
      phase1Waiting = resolve;
    });

    const fenceTx = withTransaction(async (tx: pkg.PoolClient) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
      fenceHoldsL1();
      // Hold L1 while Phase-1 starts and blocks.
      await phase1IsWaiting;
      await tx.query(
        `UPDATE system_maintenance SET active = true WHERE id = 1`
      );
      // COMMIT releases L1.
    });

    const phase1Tx = (async () => {
      await fenceHasL1;
      // Small delay to ensure the fence tx holds L1 before we try.
      await new Promise((r) => setTimeout(r, 100));
      phase1Waiting();
      return reserveStorage(worldId, 1000, makeDeps());
    })();

    const [, phase1Result] = await Promise.all([fenceTx, phase1Tx.catch((e) => e)]);

    expect(phase1Result).toMatchObject({ code: 'FENCE_ACTIVE' });
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
    // Cleanup.
    await withTransaction(deactivateFence);
  });

  it('Phase-1-wins race: reservation commits first, fence activates after', async () => {
    // Phase-1 acquires L1 first and commits; fence activation then proceeds
    // and would invalidate per §4.3d (invalidation itself is out of scope).
    const worldId = await createWorld();

    let phase1HoldsL1!: () => void;
    const phase1HasL1 = new Promise<void>((resolve) => {
      phase1HoldsL1 = resolve;
    });
    let fenceWaiting!: () => void;
    const fenceIsWaiting = new Promise<void>((resolve) => {
      fenceWaiting = resolve;
    });

    // Phase-1 holds L1 while the fence tries to activate.
    const phase1Tx = withTransaction(async (tx: pkg.PoolClient) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('media_global'))`);
      phase1HoldsL1();
      await fenceIsWaiting;
      // Simulate Phase-1 work: check fence (not active), then commit.
      const fenceOn = await isFenceActive(tx);
      expect(fenceOn).toBe(false);
      // COMMIT releases L1.
      return 'phase1-committed';
    });

    const fenceTx = (async () => {
      await phase1HasL1;
      await new Promise((r) => setTimeout(r, 100));
      fenceWaiting();
      return withTransaction(async (tx: pkg.PoolClient) => {
        await activateFence(tx, 'race-test');
        return 'fence-committed';
      });
    })();

    const [p1, f] = await Promise.all([phase1Tx, fenceTx]);
    expect(p1).toBe('phase1-committed');
    expect(f).toBe('fence-committed');
    // Fence is now active.
    const active = await query(`SELECT active FROM system_maintenance WHERE id = 1`);
    expect(active.rows[0].active).toBe(true);

    await withTransaction(deactivateFence);
  });

  it('L3 uses a real FOR UPDATE row lock; missing world throws', async () => {
    const fakeId = new WorldId(crypto.randomUUID());
    await expect(
      withTransaction((tx) => lockWorldRowForUpdate(fakeId, tx))
    ).rejects.toThrow(/world not found/);

    // Real world: lock succeeds and blocks a concurrent FOR UPDATE.
    const worldId = await createWorld();
    let secondLockBlocked = false;
    const firstTx = withTransaction(async (tx: pkg.PoolClient) => {
      await lockWorldRowForUpdate(worldId, tx);
      // Hold the row lock while a second transaction tries to lock it.
      await new Promise((r) => setTimeout(r, 500));
    });
    const secondTx = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      const start = Date.now();
      await withTransaction((tx) => lockWorldRowForUpdate(worldId, tx));
      // If we get here quickly, the lock didn't block (bad).
      secondLockBlocked = Date.now() - start > 300;
    })();
    await Promise.all([firstTx, secondTx]);
    expect(secondLockBlocked).toBe(true);
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
