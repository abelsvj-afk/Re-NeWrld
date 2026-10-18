/**
 * MIG-0 integration tests — ADR-017 migrations 014/015 (ADR-017 rev 26 baseline).
 *
 * Runs against REAL PostgreSQL only: Testcontainers by default, or an
 * externally-managed server via TEST_DATABASE_URL (e.g. a local install).
 * SKIP_DB_TESTS=true / SKIP_DOCKER=true skips the suite (marks UNVERIFIED,
 * never "passing").
 *
 * Coverage (migration-plan-ADR-017.md §4.2):
 *  (a) fresh-DB migration run — all 10 tables, 10 indexes, trigger, seed row
 *  (b) runner idempotency — second runMigrations() → zero errors, no changes
 *  (c) DDL replay safety — each file's SQL re-executed verbatim in an isolated
 *      scratch DB → schema correct and unchanged (verifies IF NOT EXISTS /
 *      DO-block guards; the runner's skip behavior alone does NOT prove this)
 *  (d) S46-step-17 CHECK probes on backfill_conflicts (rev 26)
 *  (e) roles trigger/CHECK probes on world_media_assets (rev 19 — B1)
 *  (f) S57 migration atomicity — broken variant rolls back fully
 *  (g) single-active-run + one-unrevoked-auth partial unique indexes
 *
 * Protocol-level probes (S61–S67, S5, S43, …) require application code and
 * belong to the implementation slices, NOT to this migration test file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../scripts/migrate.js';
import pkg from 'pg';
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

// Per-run unique seed (2026-10-13 lesson): re-runs against a persistent
// TEST_DATABASE_URL must not collide with rows from a previous run.
const RUN = `mig0_${Date.now().toString(36)}`;
let n = 0;
const uid = (p: string) => `${p}_${RUN}_${n++}`;

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

const EXPECTED_TABLES = [
  'system_maintenance',
  'recovery_authorizations',
  'backfill_runs',
  'backfill_inventory_files',
  'backfill_conflicts',
  'world_media_assets',
  'asset_snapshot_references',
  'unattributed_media_files',
  'world_deletion_jobs',
  'storage_reservations',
];

// The 10 explicit CREATE INDEX statements (the 2 UNIQUE constraints on
// world_media_assets create implicit backing indexes and are counted as
// constraints, not in the 10 — index-count reconciliation, planning review).
const EXPECTED_INDEXES = [
  'one_unrevoked_recovery_auth',
  'one_active_backfill_run',
  'idx_backfill_inventory_files_run_id',
  'idx_world_media_assets_world_id',
  'idx_world_media_assets_world_id_lifecycle',
  'idx_world_media_assets_backfill_run_id',
  'idx_asset_snapshot_references_snapshot_id',
  'idx_asset_snapshot_references_world_id',
  'idx_unattributed_media_files_backfill_run_id',
  'idx_storage_reservations_expires_at',
];

async function tableNames(pool: InstanceType<typeof Pool>): Promise<string[]> {
  const res = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  return res.rows.map((r) => r.table_name);
}

async function indexNames(pool: InstanceType<typeof Pool>): Promise<string[]> {
  const res = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY indexname`,
    [EXPECTED_TABLES]
  );
  return res.rows.map((r) => r.indexname);
}

/** Canonical schema snapshot for before/after replay comparison. */
async function schemaSnapshot(pool: InstanceType<typeof Pool>): Promise<string> {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`
  );
  const cols = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2`
  );
  const idx = await pool.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2`
  );
  const trg = await pool.query(
    `SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`
  );
  const con = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace ORDER BY 1`
  );
  return JSON.stringify({
    tables: tables.rows, cols: cols.rows, idx: idx.rows, trg: trg.rows, con: con.rows,
  });
}

describeFn('MIG-0 — ADR-017 migrations 014/015', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connectionString: string;

  beforeAll(async () => {
    const externalUrl = process.env.TEST_DATABASE_URL;
    if (externalUrl) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
    }
  }, 120000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  it('(a) fresh-DB migration run creates all 014/015 objects', async () => {
    await runMigrations(connectionString);
    const pool = new Pool({ connectionString });
    try {
      const tables = await tableNames(pool);
      for (const t of EXPECTED_TABLES) expect(tables).toContain(t);

      const indexes = await indexNames(pool);
      for (const i of EXPECTED_INDEXES) expect(indexes).toContain(i);

      // Trigger exists and is enabled (tgenabled='O' = origin/enabled; 'D' = disabled)
      const trg = await pool.query(
        `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_world_media_assets_roles_unique' AND tgenabled <> 'D'`
      );
      expect(trg.rows.length).toBe(1);

      // Singleton maintenance row seeded
      const seed = await pool.query(`SELECT id, active FROM system_maintenance WHERE id = 1`);
      expect(seed.rows.length).toBe(1);
      expect(seed.rows[0].active).toBe(false);

      // Migration versions recorded
      const mig = await pool.query(`SELECT version FROM schema_migrations WHERE version IN (14, 15) ORDER BY version`);
      expect(mig.rows.map((r) => r.version)).toEqual([14, 15]);
    } finally {
      await pool.end();
    }
  }, 120000);

  it('(b) runner idempotency — second runMigrations() is a clean no-op', async () => {
    const pool = new Pool({ connectionString });
    try {
      const beforeTables = await tableNames(pool);
      const beforeMig = await pool.query(`SELECT version, name FROM schema_migrations ORDER BY version`);

      await runMigrations(connectionString); // must not throw

      const afterTables = await tableNames(pool);
      const afterMig = await pool.query(`SELECT version, name FROM schema_migrations ORDER BY version`);
      expect(afterTables).toEqual(beforeTables);
      expect(afterMig.rows).toEqual(beforeMig.rows);
    } finally {
      await pool.end();
    }
  }, 120000);

  it('(c) DDL replay safety — re-executing 014/015 SQL verbatim changes nothing', async () => {
    // Isolated scratch database: never the shared test DB, never production.
    const scratchUrl = (process.env.TEST_DATABASE_URL_SCRATCH || process.env.TEST_DATABASE_URL || '').replace(
      /\/[^/]*$/,
      '/migtest_replay'
    );
    if (!scratchUrl || !process.env.TEST_DATABASE_URL) {
      throw new Error('DDL replay safety requires TEST_DATABASE_URL (scratch DB migtest_replay derived from it).');
    }
    const scratch = new Pool({ connectionString: scratchUrl });
    try {
      // Baseline: full migration chain on the scratch DB.
      await runMigrations(scratchUrl);
      const before = await schemaSnapshot(scratch);

      // Replay each file's SQL VERBATIM (not via the runner's skip logic).
      for (const file of ['014_media_durable_ops.sql', '015_media_registry.sql']) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const client = await scratch.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Replay of ${file} failed (missing idempotency guard): ${err}`);
        } finally {
          client.release();
        }
      }

      const after = await schemaSnapshot(scratch);
      expect(after).toBe(before); // schema correct AND unchanged
    } finally {
      await scratch.end();
    }
  }, 180000);

  it('(d) S46-step-17 — backfill_conflicts CHECK conformance probes (rev 26)', async () => {
    const pool = new Pool({ connectionString });
    try {
      const runRes = await pool.query(
        `INSERT INTO backfill_runs (state) VALUES ('in_progress') RETURNING run_id`
      );
      const runId = runRes.rows[0].run_id;
      const sid1 = '11111111-1111-1111-1111-111111111111';
      const sid2 = '22222222-2222-2222-2222-222222222222';

      // (i) NULL-subtype drift row MUST be rejected (the rev-26 three-valued-logic regression).
      await expect(
        pool.query(
          `INSERT INTO backfill_conflicts (run_id, filename, url, reason, subtype, expected_snapshot_ids, actual_snapshot_ids)
           VALUES ($1, $2, '/media/x', 'snapshot_ref_drift', NULL, $3, '{}')`,
          [runId, uid('f'), [sid1]]
        )
      ).rejects.toThrow(/check_violation|violates check constraint/i);

      // (ii) valid missing_row accepted.
      const ok1 = await pool.query(
        `INSERT INTO backfill_conflicts (run_id, filename, url, reason, subtype, expected_snapshot_ids, actual_snapshot_ids)
         VALUES ($1, $2, '/media/y', 'snapshot_ref_drift', 'missing_row', $3, '{}') RETURNING conflict_id`,
        [runId, uid('f'), [sid1]]
      );
      expect(ok1.rows.length).toBe(1);

      // (iii) valid stale_row with NULL run_id (operator-originated) accepted.
      const ok2 = await pool.query(
        `INSERT INTO backfill_conflicts (run_id, filename, url, reason, subtype, expected_snapshot_ids, actual_snapshot_ids)
         VALUES (NULL, $1, '/media/z', 'snapshot_ref_drift', 'stale_row', $2, $3) RETURNING conflict_id`,
        [uid('f'), [sid1], [sid1, sid2]]
      );
      expect(ok2.rows.length).toBe(1);

      // (iv) non-drift reason WITH drift fields populated MUST be rejected.
      await expect(
        pool.query(
          `INSERT INTO backfill_conflicts (run_id, filename, url, reason, subtype, expected_snapshot_ids, actual_snapshot_ids)
           VALUES ($1, $2, '/media/w', 'world_mismatch', 'missing_row', $3, '{}')`,
          [runId, uid('f'), [sid1]]
        )
      ).rejects.toThrow(/check_violation|violates check constraint/i);

      // (v) bad subtype value MUST be rejected.
      await expect(
        pool.query(
          `INSERT INTO backfill_conflicts (run_id, filename, url, reason, subtype, expected_snapshot_ids, actual_snapshot_ids)
           VALUES ($1, $2, '/media/v', 'snapshot_ref_drift', 'bogus', $3, '{}')`,
          [runId, uid('f'), [sid1]]
        )
      ).rejects.toThrow(/check_violation|violates check constraint/i);

      // (vi) NULL arrays on a drift row MUST be rejected.
      await expect(
        pool.query(
          `INSERT INTO backfill_conflicts (run_id, filename, url, reason, subtype, expected_snapshot_ids, actual_snapshot_ids)
           VALUES ($1, $2, '/media/u', 'snapshot_ref_drift', 'missing_row', NULL, '{}')`,
          [runId, uid('f')]
        )
      ).rejects.toThrow(/check_violation|violates check constraint/i);

      // Close the probe run so the single-active-run index (test g) is unaffected.
      await pool.query(`UPDATE backfill_runs SET state = 'failed', failure_reason = 'probe cleanup' WHERE run_id = $1`, [
        runId,
      ]);
    } finally {
      await pool.end();
    }
  }, 60000);

  it('(e) roles domain CHECK + uniqueness trigger probes (rev 19 — B1)', async () => {
    const pool = new Pool({ connectionString });
    try {
      const userRes = await pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, 'hash', 'creator') RETURNING user_id`,
        [uid('creator') + '@test.local']
      );
      const worldRes = await pool.query(
        `INSERT INTO worlds (creator_id, title) VALUES ($1, 'MIG-0 World') RETURNING world_id`,
        [userRes.rows[0].user_id]
      );
      const worldId = worldRes.rows[0].world_id;
      const mk = () => ({ filename: uid('f') + '.png', url: '/media/' + uid('u') + '.png' });

      // (i) duplicate roles rejected by the trigger with check_violation.
      {
        const { filename, url } = mk();
        await expect(
          pool.query(
            `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, roles)
             VALUES ($1, $2, $3, 'image/png', 100, '{cover,cover}')`,
            [worldId, filename, url]
          )
        ).rejects.toThrow(/duplicates/);
      }

      // (ii) invalid role value rejected by the domain CHECK.
      {
        const { filename, url } = mk();
        await expect(
          pool.query(
            `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, roles)
             VALUES ($1, $2, $3, 'image/png', 100, '{bogus}')`,
            [worldId, filename, url]
          )
        ).rejects.toThrow(/check_violation|violates check constraint/i);
      }

      // (iii) empty array accepted.
      {
        const { filename, url } = mk();
        const r = await pool.query(
          `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, roles)
           VALUES ($1, $2, $3, 'image/png', 100, '{}') RETURNING asset_id`,
          [worldId, filename, url]
        );
        expect(r.rows.length).toBe(1);
      }

      // (iv) UPDATE introducing duplicates rejected.
      {
        const { filename, url } = mk();
        const r = await pool.query(
          `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, roles)
           VALUES ($1, $2, $3, 'image/png', 100, '{cover}') RETURNING asset_id`,
          [worldId, filename, url]
        );
        await expect(
          pool.query(`UPDATE world_media_assets SET roles = '{cover,illustration,cover}' WHERE asset_id = $1`, [
            r.rows[0].asset_id,
          ])
        ).rejects.toThrow(/duplicates/);
      }

      // (v) reorder (same set, no duplicates) accepted.
      {
        const { filename, url } = mk();
        const r = await pool.query(
          `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, roles)
           VALUES ($1, $2, $3, 'image/png', 100, '{cover,illustration}') RETURNING asset_id`,
          [worldId, filename, url]
        );
        const u = await pool.query(
          `UPDATE world_media_assets SET roles = '{illustration,cover}' WHERE asset_id = $1 RETURNING asset_id`,
          [r.rows[0].asset_id]
        );
        expect(u.rows.length).toBe(1);
      }

      // (vi) NULL roles rejected by NOT NULL.
      {
        const { filename, url } = mk();
        await expect(
          pool.query(
            `INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, roles)
             VALUES ($1, $2, $3, 'image/png', 100, NULL)`,
            [worldId, filename, url]
          )
        ).rejects.toThrow(/not-null|violates not-null/i);
      }
    } finally {
      await pool.end();
    }
  }, 60000);

  it('(f) S57 — broken migration variant rolls back atomically', async () => {
    // Isolated scratch database; the broken SQL never ships.
    const scratchUrl = (process.env.TEST_DATABASE_URL || '').replace(/\/[^/]*$/, '/migtest_atomic');
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error('S57 atomicity test requires TEST_DATABASE_URL (scratch DB migtest_atomic derived from it).');
    }
    const scratch = new Pool({ connectionString: scratchUrl });
    try {
      const client = await scratch.connect();
      try {
        await client.query('BEGIN');
        await expect(
          client.query(`CREATE TABLE s57_probe (id INT PRIMARY KEY); SELECT * FROM nonexistent_table_xyz;`)
        ).rejects.toThrow();
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const check = await scratch.query(`SELECT to_regclass('public.s57_probe') AS c`);
      expect(check.rows[0].c).toBeNull(); // no partial table survived
    } finally {
      await scratch.end();
    }
  }, 60000);

  it('(g) single-active-run + one-unrevoked-auth partial unique indexes', async () => {
    const pool = new Pool({ connectionString });
    try {
      // Two in_progress runs → second violates the partial unique index.
      const r1 = await pool.query(`INSERT INTO backfill_runs (state) VALUES ('in_progress') RETURNING run_id`);
      await expect(pool.query(`INSERT INTO backfill_runs (state) VALUES ('in_progress')`)).rejects.toThrow(
        /duplicate key|unique/i
      );
      // A failed run does not block: failed-state rows are outside the predicate.
      const rf = await pool.query(
        `INSERT INTO backfill_runs (state) VALUES ('failed') RETURNING run_id`
      );
      expect(rf.rows.length).toBe(1);
      await pool.query(`UPDATE backfill_runs SET state = 'failed' WHERE run_id = $1`, [r1.rows[0].run_id]);

      // Two unrevoked authorizations → second violates one_unrevoked_recovery_auth.
      const a1 = await pool.query(
        `INSERT INTO recovery_authorizations (scope, authorized_by, reason) VALUES ('repair', 'op1', 'test') RETURNING authorization_id`
      );
      await expect(
        pool.query(`INSERT INTO recovery_authorizations (scope, authorized_by, reason) VALUES ('repair', 'op2', 'test')`)
      ).rejects.toThrow(/duplicate key|unique/i);
      // Revoked + unrevoked → allowed.
      await pool.query(
        `UPDATE recovery_authorizations SET revoked_at = now(), revoke_reason = 'operator' WHERE authorization_id = $1`,
        [a1.rows[0].authorization_id]
      );
      const a2 = await pool.query(
        `INSERT INTO recovery_authorizations (scope, authorized_by, reason) VALUES ('restore-reconcile', 'op2', 'test') RETURNING authorization_id`
      );
      expect(a2.rows.length).toBe(1);
      await pool.query(`UPDATE recovery_authorizations SET revoked_at = now(), revoke_reason = 'operator'`);
    } finally {
      await pool.end();
    }
  }, 60000);
});
