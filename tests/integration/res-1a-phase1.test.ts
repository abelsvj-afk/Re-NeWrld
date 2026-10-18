import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../scripts/migrate.js';
import { setPool, closePool, query } from '../../src/shared/database/db.js';
import { PostgresStorageReservationRepository } from '../../src/modules/world/infrastructure/persistence/postgres-storage-reservation.repository.js';
import {
  reserveStorage,
  ReservationRejectedError,
  ReserveStorageDeps,
  CapacityMetric,
} from '../../src/modules/world/domain/services/reserve-storage.service.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import type pkg from 'pg';
import crypto from 'node:crypto';

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

describeFn('RES-1a Phase-1 check-and-reserve (integration)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let repository: PostgresStorageReservationRepository;

  // Test doubles for the capacity/fence/world dependencies.
  let fenceActive = false;
  let metric: CapacityMetric | null;
  let registeredBytesByWorld: Map<string, number>;
  let worldsExist: Set<string>;

  const QUOTA_BYTES = 50 * 1024 * 1024; // 50 MB
  const NARRATION_RESERVE = 1024 * 1024 * 1024; // 1 GiB

  function makeDeps(): ReserveStorageDeps {
    return {
      reservationRepository: repository,
      getCapacityMetric: async () => metric,
      isFenceActive: async () => fenceActive,
      getRegisteredBytes: async (worldId) =>
        registeredBytesByWorld.get(worldId.getValue()) ?? 0,
      lockWorldRow: async (worldId, tx: pkg.PoolClient) => {
        if (!worldsExist.has(worldId.getValue())) {
          throw new Error(`world not found: ${worldId.getValue()}`);
        }
        // Simulate the FOR UPDATE row lock.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('world_row:' || $1))`, [
          worldId.getValue(),
        ]);
      },
      quotaBytes: QUOTA_BYTES,
      narrationReserveBytes: NARRATION_RESERVE,
      metricMaxAgeMs: 5 * 60 * 1000,
    };
  }

  function freshMetric(): CapacityMetric {
    return {
      storageCapacityBytes: Math.round(2.5 * 1024 * 1024 * 1024),
      storageUsedBytes: 0,
      activeReservationsAtMeasureTime: 0,
      narrationBytes: 100 * 1024 * 1024,
      measuredAt: new Date(),
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
    repository = new PostgresStorageReservationRepository();
  }, 120000);

  afterAll(async () => {
    await closePool();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await query(`DELETE FROM storage_reservations`);
    fenceActive = false;
    metric = freshMetric();
    registeredBytesByWorld = new Map();
    worldsExist = new Set();
  });

  function newWorldId(): WorldId {
    const id = new WorldId(crypto.randomUUID());
    worldsExist.add(id.getValue());
    return id;
  }

  it('creates a RESERVED reservation on the happy path', async () => {
    const worldId = newWorldId();
    const r = await reserveStorage(worldId, 1024 * 1024, makeDeps());

    expect(r.state).toBe('RESERVED');
    expect(r.releasedAt).toBeNull();
    expect(r.sizeBytes).toBe(1024 * 1024);
    expect(r.worldId.getValue()).toBe(worldId.getValue());
    // expires_at ≈ now + 5 minutes (within 60s tolerance).
    const skew = r.expiresAt.getTime() - Date.now() - 5 * 60 * 1000;
    expect(Math.abs(skew)).toBeLessThan(60000);
  });

  it('rejects when the world quota would be exceeded', async () => {
    const worldId = newWorldId();
    registeredBytesByWorld.set(worldId.getValue(), QUOTA_BYTES - 100);

    await expect(reserveStorage(worldId, 200, makeDeps())).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      httpStatus: 507,
    });
    // No leaked row.
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
  });

  it('allows exact-boundary admission (used + size == quota)', async () => {
    const worldId = newWorldId();
    registeredBytesByWorld.set(worldId.getValue(), QUOTA_BYTES - 1000);

    const r = await reserveStorage(worldId, 1000, makeDeps());
    expect(r.state).toBe('RESERVED');
  });

  it('rejects one byte over quota', async () => {
    const worldId = newWorldId();
    registeredBytesByWorld.set(worldId.getValue(), QUOTA_BYTES - 1000);

    await expect(reserveStorage(worldId, 1001, makeDeps())).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('counts outstanding reservations against quota (S5-partial)', async () => {
    const worldId = newWorldId();
    const deps = makeDeps();
    // First reservation consumes half the quota.
    await reserveStorage(worldId, QUOTA_BYTES / 2, deps);
    // Second sees the first's committed row.
    await expect(reserveStorage(worldId, QUOTA_BYTES / 2 + 1, deps)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    // Exactly one row exists.
    expect(await repository.sumActiveBytes(worldId)).toBe(QUOTA_BYTES / 2);
  });

  it('rejects when physical capacity is insufficient (S38)', async () => {
    const worldId = newWorldId();
    metric!.storageCapacityBytes = 1000;
    metric!.storageUsedBytes = 600; // 400 available

    await expect(reserveStorage(worldId, 500, makeDeps())).rejects.toMatchObject({
      code: 'STORAGE_FULL',
      httpStatus: 507,
    });
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
  });

  it('rejects on stale metric (fail-closed)', async () => {
    const worldId = newWorldId();
    metric!.measuredAt = new Date(Date.now() - 10 * 60 * 1000);

    await expect(reserveStorage(worldId, 1000, makeDeps())).rejects.toMatchObject({
      code: 'STORAGE_METRIC_STALE',
      httpStatus: 503,
    });
  });

  it('rejects when narration reserve is reached (hard boundary)', async () => {
    const worldId = newWorldId();
    metric!.narrationBytes = NARRATION_RESERVE;

    await expect(reserveStorage(worldId, 1000, makeDeps())).rejects.toMatchObject({
      code: 'NARRATION_CAPACITY_EXCEEDED',
      httpStatus: 503,
    });
  });

  it('rejects when the fence is active', async () => {
    const worldId = newWorldId();
    fenceActive = true;

    await expect(reserveStorage(worldId, 1000, makeDeps())).rejects.toMatchObject({
      code: 'FENCE_ACTIVE',
      httpStatus: 503,
    });
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
  });

  it('fence-wins race: fence activates first, Phase-1 rejects before L2/L3', async () => {
    // Deterministic barrier: fence activation completes before Phase-1 starts.
    // This simulates the serialized ordering where the fence holds L1 first.
    const worldId = newWorldId();
    fenceActive = true; // Fence committed before Phase-1 acquires L1.

    const deps = makeDeps();
    // Track whether L2/L3 were acquired by wrapping lockWorldRow.
    let l2l3Acquired = false;
    const origLock = deps.lockWorldRow;
    deps.lockWorldRow = async (wid, tx) => {
      l2l3Acquired = true;
      return origLock(wid, tx);
    };

    await expect(reserveStorage(worldId, 1000, deps)).rejects.toMatchObject({
      code: 'FENCE_ACTIVE',
    });
    // Fence check runs immediately after L1, before L2/L3.
    expect(l2l3Acquired).toBe(false);
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
  });

  it('Phase-1-wins race: reservation commits before fence activation', async () => {
    // Deterministic barrier: Phase-1 completes before the fence activates.
    const worldId = newWorldId();
    const r = await reserveStorage(worldId, 1000, makeDeps());
    expect(r.state).toBe('RESERVED');

    // Fence activates after the reservation committed.
    fenceActive = true;
    // The reservation exists and would be invalidated per §4.3d (not tested here).
    const found = await repository.findById(r.reservationId);
    expect(found?.state).toBe('RESERVED');
  });

  it('concurrent Phase-1s for different worlds respect shared capacity (S38)', async () => {
    const w1 = newWorldId();
    const w2 = newWorldId();
    // 1500 bytes total capacity, 0 used. Two 1000-byte requests → only one fits.
    metric!.storageCapacityBytes = 1500;
    metric!.storageUsedBytes = 0;

    const results = await Promise.allSettled([
      reserveStorage(w1, 1000, makeDeps()),
      reserveStorage(w2, 1000, makeDeps()),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    // Only one can succeed: 1000 + 1000 > 1500.
    expect(succeeded).toBe(1);
    // Total reserved does not exceed capacity.
    const total = await repository.sumActiveBytes();
    expect(total).toBeLessThanOrEqual(1500);
  });

  it('rolls back cleanly on DB failure during INSERT (no partial row)', async () => {
    const worldId = newWorldId();
    const deps = makeDeps();
    // Sabotage the repository to throw during create.
    const origCreate = repository.create.bind(repository);
    repository.create = async () => {
      throw new Error('simulated DB failure');
    };
    try {
      await expect(reserveStorage(worldId, 1000, deps)).rejects.toThrow('simulated DB failure');
    } finally {
      repository.create = origCreate;
    }
    expect(await repository.sumActiveBytes(worldId)).toBe(0);
  });

  it('validates sizeBytes is a positive integer', async () => {
    const worldId = newWorldId();
    await expect(reserveStorage(worldId, 0, makeDeps())).rejects.toThrow();
    await expect(reserveStorage(worldId, -5, makeDeps())).rejects.toThrow();
    await expect(reserveStorage(worldId, 1.5, makeDeps())).rejects.toThrow();
  });
});
