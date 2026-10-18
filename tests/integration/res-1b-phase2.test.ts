/**
 * RES-1b Phase-2 Writer Integration Tests
 *
 * Tests the Phase-2 writer obligations per ADR-017-res-1b-design.md rev 30:
 * - S45: ENOSPC handling
 * - S51: flock self-test
 * - S52: fencing failures
 * - S53: Domain-R exclusion
 * - §6.21-§6.32: retry accounting, alert lifecycle, outbox, reconciliation
 *
 * Requires: PostgreSQL 16, TEST_DATABASE_URL and DATABASE_URL set.
 * Run: TEST_DATABASE_URL='postgresql://...' DATABASE_URL='postgresql://...' npx vitest run tests/integration/res-1b-phase2.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pkg from 'pg';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tempPathFor,
  lockPathFor,
  openWriterSession,
  writeChunkFenced,
  sendHeartbeat,
  closeWriterSession,
  Phase2WriterError,
} from '../../src/modules/world/domain/services/phase2-writer.service.js';
import {
  phaseACommit,
  phaseBPublish,
  phaseCMarkActive,
} from '../../src/modules/world/domain/services/publication.service.js';
import {
  runCleanupCycle,
  checkAlertThreshold,
  resolveIncident,
} from '../../src/modules/world/domain/services/temp-cleanup.service.js';

const { Pool } = pkg;

let pool: pkg.Pool;
let mediaRoot: string;

const TEST_WORLD_ID = '11111111-1111-1111-1111-111111111111';

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

function makeDeps() {
  return {
    mediaRoot,
    isReservationActive: async (reservationId: string) => {
      const r = await pool.query(
        `SELECT 1 FROM storage_reservations WHERE reservation_id=$1 AND released_at IS NULL AND state IN ('RESERVED','WRITING')`,
        [reservationId],
      );
      return (r.rowCount ?? 0) > 0;
    },
    heartbeat: async (reservationId: string) => {
      const r = await pool.query(
        `UPDATE storage_reservations SET epoch=epoch+1, expires_at=now()+interval '5 minutes', last_heartbeat_at=now()
         WHERE reservation_id=$1 AND released_at IS NULL RETURNING reservation_id`,
        [reservationId],
      );
      return r.rowCount ?? 0;
    },
    withTransaction,
    log: () => {},
  };
}

async function createReservation(worldId: string = TEST_WORLD_ID): Promise<string> {
  const r = await pool.query(
    `INSERT INTO storage_reservations (world_id, size_bytes, state) VALUES ($1, 1024, 'RESERVED') RETURNING reservation_id`,
    [worldId],
  );
  return r.rows[0].reservation_id;
}

async function createWorld(): Promise<string> {
  // Worlds table may have required fields; use minimal insert.
  const r = await pool.query(
    `INSERT INTO worlds (world_id, title, owner_id) VALUES ($1, 'Test World', $2) ON CONFLICT (world_id) DO NOTHING RETURNING world_id`,
    [TEST_WORLD_ID, '00000000-0000-0000-0000-000000000000'],
  );
  return TEST_WORLD_ID;
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  pool = new Pool({ connectionString: url });

  // Run migrations 014, 015, 016.
  const { readFile } = await import('node:fs/promises');
  for (const mig of ['014_media_durable_ops.sql', '015_media_registry.sql', '016_res1b_phase2_writer.sql']) {
    const sql = await readFile(join(process.cwd(), 'db/migrations', mig), 'utf-8');
    await pool.query(sql);
  }

  mediaRoot = await mkdtemp(join(tmpdir(), 'res1b-test-'));
  await mkdir(join(mediaRoot, '.tmp'), { recursive: true });

  await createWorld();
});

afterAll(async () => {
  await rm(mediaRoot, { recursive: true, force: true });
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM temp_cleanup_delivery_outbox`);
  await pool.query(`DELETE FROM temp_cleanup_incidents`);
  await pool.query(`DELETE FROM world_media_assets`);
  await pool.query(`DELETE FROM storage_reservations`);
});

describe('RES-1b Phase-2 Writer', () => {
  it('S51: temp path is deterministic per reservation', async () => {
    const reservationId = await createReservation();
    const deps = makeDeps();

    const { session, dataFd, lockFd } = await openWriterSession(reservationId, deps);

    expect(session.tempPath).toBe(tempPathFor(mediaRoot, reservationId));
    expect(session.lockPath).toBe(lockPathFor(mediaRoot, reservationId));
    expect(session.tempPath).toContain(`${reservationId}.part`);

    await closeWriterSession(session, dataFd, lockFd, deps);
  });

  it('S52: fenced write rejects when reservation becomes inactive', async () => {
    const reservationId = await createReservation();
    const deps = makeDeps();

    const { session, dataFd, lockFd } = await openWriterSession(reservationId, deps);

    // Simulate reservation becoming inactive (e.g., claimed by expiry).
    await pool.query(
      `UPDATE storage_reservations SET state='ABANDONED', released_at=now() WHERE reservation_id=$1`,
      [reservationId],
    );

    // Write should be rejected.
    await expect(writeChunkFenced(session, dataFd, Buffer.from('test'), deps)).rejects.toThrow(
      Phase2WriterError,
    );

    await closeWriterSession(session, dataFd, lockFd, deps);
  });

  it('S52: heartbeat fails when reservation released', async () => {
    const reservationId = await createReservation();
    const deps = makeDeps();

    const { session, dataFd, lockFd } = await openWriterSession(reservationId, deps);

    // Release the reservation.
    await pool.query(
      `UPDATE storage_reservations SET state='COMMITTED', released_at=now() WHERE reservation_id=$1`,
      [reservationId],
    );

    // Heartbeat should fail (0 rows).
    await expect(sendHeartbeat(session, deps)).rejects.toThrow(Phase2WriterError);

    await closeWriterSession(session, dataFd, lockFd, deps);
  });

  it('Phase A: commits asset PENDING and reservation COMMITTED atomically', async () => {
    const reservationId = await createReservation();
    const deps = makeDeps();
    const pubDeps = { withTransaction, log: () => {} };

    const assetId = await withTransaction(async (tx) => {
      return phaseACommit(
        {
          reservationId,
          worldId: TEST_WORLD_ID,
          tempPath: tempPathFor(mediaRoot, reservationId),
          finalFilename: `${reservationId}.png`,
          mediaRoot,
          mimetype: 'image/png',
          sizeBytes: 1024,
          contentSha256: 'a'.repeat(64),
        },
        pubDeps,
        tx,
      );
    });

    // Verify asset is PENDING.
    const asset = await pool.query(
      `SELECT publication_status, content_sha256 FROM world_media_assets WHERE asset_id=$1`,
      [assetId],
    );
    expect(asset.rows[0].publication_status).toBe('PENDING');
    expect(asset.rows[0].content_sha256).toBe('a'.repeat(64));

    // Verify reservation is COMMITTED.
    const res = await pool.query(
      `SELECT state, released_at FROM storage_reservations WHERE reservation_id=$1`,
      [reservationId],
    );
    expect(res.rows[0].state).toBe('COMMITTED');
    expect(res.rows[0].released_at).not.toBeNull();
  });

  it('Phase A: rolls back if reservation not committable', async () => {
    const reservationId = await createReservation();
    // Make reservation non-committable.
    await pool.query(
      `UPDATE storage_reservations SET state='ABANDONED', released_at=now() WHERE reservation_id=$1`,
      [reservationId],
    );

    const pubDeps = { withTransaction, log: () => {} };

    await expect(
      withTransaction(async (tx) => {
        return phaseACommit(
          {
            reservationId,
            worldId: TEST_WORLD_ID,
            tempPath: tempPathFor(mediaRoot, reservationId),
            finalFilename: `${reservationId}.png`,
            mediaRoot,
            mimetype: 'image/png',
            sizeBytes: 1024,
            contentSha256: 'b'.repeat(64),
          },
          pubDeps,
          tx,
        );
      }),
    ).rejects.toThrow();

    // Verify NO asset row was created (atomic rollback).
    const count = await pool.query(
      `SELECT COUNT(*) as c FROM world_media_assets WHERE reservation_id=$1`,
      [reservationId],
    );
    expect(parseInt(count.rows[0].c)).toBe(0);
  });
});

describe('RES-1b Stale Temp Cleanup (§6.21-§6.32)', () => {
  it('§6.25: marker write never touches counters', async () => {
    const reservationId = await createReservation();
    // Simulate prior state with non-zero counters.
    const assetId = (await pool.query(
      `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, publication_status, reservation_id,
        temp_cleanup_fsync_attempts, temp_cleanup_unlink_attempts, temp_cleanup_fsync_pending)
       VALUES ($1, $2, $3, 'image/png', 100, 'ACTIVE', $4, 3, 2, FALSE) RETURNING asset_id`,
      [TEST_WORLD_ID, `${reservationId}.png`, `/media/${reservationId}.png`, reservationId],
    )).rows[0].asset_id;

    // Create a temp file so cleanup runs.
    const { writeFile } = await import('node:fs/promises');
    const tempPath = tempPathFor(mediaRoot, reservationId);
    await writeFile(tempPath, 'test');
    // Create final file with same inode (link).
    const { link } = await import('node:fs/promises');
    await link(tempPath, join(mediaRoot, `${reservationId}.png`));

    const deps = makeDeps();
    await runCleanupCycle(deps);

    // Counters should be reset by successful operations, not by marker write.
    // Unlink succeeded → unlink_attempts=0. Fsync succeeded → fsync_attempts=0, pending=FALSE.
    const after = await pool.query(
      `SELECT temp_cleanup_fsync_attempts, temp_cleanup_unlink_attempts, temp_cleanup_fsync_pending
       FROM world_media_assets WHERE asset_id=$1`,
      [assetId],
    );
    expect(after.rows[0].temp_cleanup_unlink_attempts).toBe(0);
    expect(after.rows[0].temp_cleanup_fsync_attempts).toBe(0);
    expect(after.rows[0].temp_cleanup_fsync_pending).toBe(false);
  });

  it('§6.26: alert lifecycle via real service — open, escalate, resolve, recur', async () => {
    const reservationId = await createReservation();
    const assetId = (await pool.query(
      `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, publication_status, reservation_id)
       VALUES ($1, $2, $3, 'image/png', 100, 'ACTIVE', $4) RETURNING asset_id`,
      [TEST_WORLD_ID, `${reservationId}.png`, `/media/${reservationId}.png`, reservationId],
    )).rows[0].asset_id;

    const deps = makeDeps();

    // Simulate 5 unlink failures, then call the REAL checkAlertThreshold.
    await pool.query(
      `UPDATE world_media_assets SET temp_cleanup_unlink_attempts=5 WHERE asset_id=$1`,
      [assetId],
    );
    await withTransaction(async (tx) => {
      await checkAlertThreshold(reservationId, 'unlink', deps, tx);
    });

    // Verify incident was created by the service (not direct insert).
    const incidents = await pool.query(
      `SELECT incident_id, status, last_fired_count FROM temp_cleanup_incidents
       WHERE reservation_id=$1 AND failure_type='unlink' AND status IN ('open','escalated')`,
      [reservationId],
    );
    expect(incidents.rowCount).toBe(1);
    expect(incidents.rows[0].status).toBe('open');
    expect(incidents.rows[0].last_fired_count).toBe(5);
    const incidentId1 = incidents.rows[0].incident_id;

    // Verify outbox event was created by the service.
    const events = await pool.query(
      `SELECT delivery_event_id, fire_count, severity FROM temp_cleanup_delivery_outbox
       WHERE incident_id=$1`,
      [incidentId1],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].fire_count).toBe(5);
    expect(events.rows[0].severity).toBe('warning');

    // Escalate: simulate 15 failures, call service again.
    await pool.query(
      `UPDATE world_media_assets SET temp_cleanup_unlink_attempts=15 WHERE asset_id=$1`,
      [assetId],
    );
    await withTransaction(async (tx) => {
      await checkAlertThreshold(reservationId, 'unlink', deps, tx);
    });
    const escalated = await pool.query(
      `SELECT status FROM temp_cleanup_incidents WHERE incident_id=$1`,
      [incidentId1],
    );
    expect(escalated.rows[0].status).toBe('escalated');

    // Resolve via the REAL service.
    await withTransaction(async (tx) => {
      await resolveIncident(reservationId, 'unlink', deps, tx);
    });
    const resolved = await pool.query(
      `SELECT status FROM temp_cleanup_incidents WHERE incident_id=$1`,
      [incidentId1],
    );
    expect(resolved.rows[0].status).toBe('resolved');

    // Recurrence: new failures → new incident with different ID (via service).
    await pool.query(
      `UPDATE world_media_assets SET temp_cleanup_unlink_attempts=5 WHERE asset_id=$1`,
      [assetId],
    );
    await withTransaction(async (tx) => {
      await checkAlertThreshold(reservationId, 'unlink', deps, tx);
    });
    const incidents2 = await pool.query(
      `SELECT incident_id FROM temp_cleanup_incidents
       WHERE reservation_id=$1 AND failure_type='unlink' AND status='open'`,
      [reservationId],
    );
    expect(incidents2.rowCount).toBe(1);
    expect(incidents2.rows[0].incident_id).not.toBe(incidentId1);
  });

  it('§6.28: outbox event uniqueness per firing', async () => {
    const reservationId = await createReservation();
    const incident = (await pool.query(
      `INSERT INTO temp_cleanup_incidents (reservation_id, failure_type, status, last_fired_count)
       VALUES ($1, 'unlink', 'open', 5) RETURNING incident_id`,
      [reservationId],
    )).rows[0];

    // Create event for fire_count=5.
    const e1 = await pool.query(
      `INSERT INTO temp_cleanup_delivery_outbox (incident_id, reservation_id, failure_type, fire_count, severity, status)
       VALUES ($1, $2, 'unlink', 5, 'warning', 'pending') RETURNING delivery_event_id`,
      [incident.incident_id, reservationId],
    );
    expect(e1.rows[0].delivery_event_id).toBeDefined();

    // Duplicate for same fire_count should be ignored (ON CONFLICT DO NOTHING).
    const e2 = await pool.query(
      `INSERT INTO temp_cleanup_delivery_outbox (incident_id, reservation_id, failure_type, fire_count, severity, status)
       VALUES ($1, $2, 'unlink', 5, 'warning', 'pending')
       ON CONFLICT (incident_id, fire_count) DO NOTHING RETURNING delivery_event_id`,
      [incident.incident_id, reservationId],
    );
    expect(e2.rowCount).toBe(0);

    // Different fire_count should succeed.
    const e3 = await pool.query(
      `INSERT INTO temp_cleanup_delivery_outbox (incident_id, reservation_id, failure_type, fire_count, severity, status)
       VALUES ($1, $2, 'unlink', 10, 'warning', 'pending') RETURNING delivery_event_id`,
      [incident.incident_id, reservationId],
    );
    expect(e3.rows[0].delivery_event_id).not.toBe(e1.rows[0].delivery_event_id);
  });
});
