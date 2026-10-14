import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pkg from 'pg';
import { setPool, closePool } from '../../src/shared/database/db.js';
import { runMigrations } from '../../scripts/migrate.js';
import { SubmitChoiceUseCase } from '../../src/modules/session/application/submit-choice.use-case.js';
import { PostgresSessionRepository } from '../../src/modules/session/infrastructure/persistence/postgres-session.repository.js';
import { PostgresCanonRepository } from '../../src/modules/world/infrastructure/persistence/postgres-canon.repository.js';
import { PostgresIdempotencyRepository } from '../../src/modules/session/infrastructure/persistence/postgres-idempotency.repository.js';
import { SessionId } from '../../src/modules/session/domain/value-objects/session-id.value-object.js';
import { ChoiceId } from '../../src/modules/world/domain/value-objects/choice-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { SessionVersionConflictError } from '../../src/modules/session/domain/errors/session.errors.js';
import { IdempotencyConflictError } from '../../src/modules/session/domain/errors/choice.errors.js';

const { Pool } = pkg;

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

// Phase G integration tests (ADR-015 D7, G2). Run against real PostgreSQL:
// Testcontainers by default, or a local install via TEST_DATABASE_URL.
describeFn('Choice submission (G2)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pkg.Pool;
  let useCase: SubmitChoiceUseCase;

  const readerId = new UserId(crypto.randomUUID());
  const worldId = crypto.randomUUID();
  const S1 = crypto.randomUUID();
  const S2 = crypto.randomUUID();
  const SEND = crypto.randomUUID();
  const C1 = crypto.randomUUID(); // S1 -> S2, inc gold
  const C2 = crypto.randomUUID(); // S2 -> SEND

  function canonData(opts: { marker?: boolean; c1conditions?: unknown; c1mutations?: unknown } = {}) {
    const choices: any[] = [
      {
        choice_id: C1,
        scene_id: S1,
        target_scene_id: S2,
        text: 'Go',
        sort_order: 0,
      },
      { choice_id: C2, scene_id: S2, target_scene_id: SEND, text: 'Finish', sort_order: 0 },
    ];
    if (opts.c1conditions !== undefined) choices[0].conditions = opts.c1conditions;
    if (opts.c1mutations !== undefined) choices[0].mutations = opts.c1mutations;
    const data: any = {
      canon_schema_version: 1,
      world: { world_id: worldId, title: 'W', description: null, metadata: {}, start_scene_id: S1 },
      scenes: [
        { scene_id: S1, chapter_id: worldId, title: 'S1', prose: 'p', metadata: {}, is_ending: false },
        { scene_id: S2, chapter_id: worldId, title: 'S2', prose: 'p', metadata: {}, is_ending: false },
        { scene_id: SEND, chapter_id: worldId, title: 'End', prose: 'p', metadata: {}, is_ending: true },
      ],
      choices,
    };
    if (opts.marker !== false) data.condition_grammar_version = 1;
    return data;
  }

  async function seedSession(sessionId: string, snapshotId: string, version = 1, state: any = { gold: 10 }, scene: string = S1) {
    await pool.query(
      `INSERT INTO reader_sessions
         (session_id, reader_id, world_id, snapshot_id, current_scene_id, state_variables, version, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active')`,
      [sessionId, readerId.getValue(), worldId, snapshotId, scene, JSON.stringify(state), version]
    );
  }

  async function seedSnapshot(suffix: string, data: any): Promise<string> {
    const snapshotId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO published_canon_snapshots (snapshot_id, world_id, version_number, canon_data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [snapshotId, worldId, 100 + Math.floor(Math.random() * 1000), JSON.stringify(data)]
    );
    return snapshotId;
  }

  beforeAll(async () => {
    const externalUrl = process.env.TEST_DATABASE_URL;
    let connectionString: string;
    if (externalUrl) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
    }
    await runMigrations(connectionString);
    setPool(connectionString);
    pool = new Pool({ connectionString });

    useCase = new SubmitChoiceUseCase(
      new PostgresSessionRepository(),
      new PostgresCanonRepository(),
      new PostgresIdempotencyRepository()
    );

    // Seed base rows.
    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [readerId.getValue(), `g2-${Date.now()}@rene.wrld`, 'x', 'reader']
    );
    await pool.query(
      `INSERT INTO worlds (world_id, creator_id, title, status) VALUES ($1, $2, $3, 'published') ON CONFLICT DO NOTHING`,
      [worldId, readerId.getValue(), 'G2 World']
    );
  });

  afterAll(async () => {
    await pool?.end();
    await closePool();
    await container?.stop();
  });

  it('migration 006: idempotency_keys table exists with PK and expiry index', async () => {
    const tbl = await pool.query(`SELECT to_regclass('idempotency_keys') AS c`);
    expect(tbl.rows[0].c).toBe('idempotency_keys');
    const pk = await pool.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'idempotency_keys' AND constraint_type = 'PRIMARY KEY'`
    );
    expect(pk.rowCount).toBe(1);
    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'idempotency_keys'`
    );
    expect(idx.rows.some((r) => r.indexname.includes('expires_at'))).toBe(true);
  });

  it('end-to-end: choice progression, version increments, exact timeline envelope', async () => {
    const snapId = await seedSnapshot('e2e', canonData({ c1mutations: [{ op: 'inc', var: 'gold', by: 5 }] }));
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const key = crypto.randomUUID();

    const r1 = await useCase.execute({
      sessionId: new SessionId(sid),
      readerId,
      choiceId: new ChoiceId(C1),
      expectedVersion: 1,
      idempotencyKey: key,
    });
    expect(r1.version).toBe(2);
    expect(r1.currentSceneId).toBe(S2);
    expect(r1.appliedMutations).toEqual([{ op: 'inc', var: 'gold', value: 15 }]);

    // Timeline row: exact discriminated envelope.
    const tl = await pool.query(
      `SELECT sequence_number, from_scene_id, to_scene_id, choice_id, state_diff
       FROM reader_timelines WHERE session_id = $1 ORDER BY sequence_number`,
      [sid]
    );
    expect(tl.rows).toHaveLength(1);
    expect(tl.rows[0].sequence_number).toBe(1);
    expect(tl.rows[0].from_scene_id).toBe(S1);
    expect(tl.rows[0].to_scene_id).toBe(S2);
    expect(tl.rows[0].choice_id).toBe(C1);
    expect(tl.rows[0].state_diff).toEqual({
      kind: 'choice-execution-v1',
      applied: [{ op: 'inc', var: 'gold', value: 15 }],
    });

    // Session row: state replaced, version bumped.
    const srow = await pool.query(`SELECT version, current_scene_id, state_variables, status FROM reader_sessions WHERE session_id = $1`, [sid]);
    expect(Number(srow.rows[0].version)).toBe(2);
    expect(srow.rows[0].current_scene_id).toBe(S2);
    expect(srow.rows[0].state_variables).toEqual({ gold: 15 });
    expect(srow.rows[0].status).toBe('active');

    // Idempotency record persisted.
    const irow = await pool.query(`SELECT request_hash, response FROM idempotency_keys WHERE idempotency_key = $1`, [key]);
    expect(irow.rowCount).toBe(1);
    expect(irow.rows[0].request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(irow.rows[0].response.version).toBe(2);
  });

  it('idempotent retry returns identical data with a single timeline row', async () => {
    const snapId = await seedSnapshot('idem', canonData({}));
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const key = crypto.randomUUID();
    const cmd = {
      sessionId: new SessionId(sid),
      readerId,
      choiceId: new ChoiceId(C1),
      expectedVersion: 1,
      idempotencyKey: key,
    };
    const first = await useCase.execute(cmd);
    const second = await useCase.execute(cmd);
    expect(second).toEqual(first);
    const tl = await pool.query(`SELECT COUNT(*) AS c FROM reader_timelines WHERE session_id = $1`, [sid]);
    expect(Number(tl.rows[0].c)).toBe(1);
  });

  it('concurrent same-session submissions: exactly one wins per version', async () => {
    const snapId = await seedSnapshot('conc', canonData({}));
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const results = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((i) =>
        useCase.execute({
          sessionId: new SessionId(sid),
          readerId,
          choiceId: new ChoiceId(C1),
          expectedVersion: 1,
          idempotencyKey: crypto.randomUUID(),
        })
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SessionVersionConflictError);
    }
    const srow = await pool.query(`SELECT version FROM reader_sessions WHERE session_id = $1`, [sid]);
    expect(Number(srow.rows[0].version)).toBe(2);
  });

  it('concurrent same-key: loser replays the winner response (in-tx recheck)', async () => {
    const snapId = await seedSnapshot('samekey', canonData({ c1mutations: [{ op: 'set', var: 'x', value: 1 }] }));
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const key = crypto.randomUUID();
    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        useCase.execute({
          sessionId: new SessionId(sid),
          readerId,
          choiceId: new ChoiceId(C1),
          expectedVersion: 1,
          idempotencyKey: key,
        })
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // All fulfilled responses are deep-equal (winner's response replayed).
    for (const f of fulfilled) {
      expect(f.value).toEqual(fulfilled[0].value);
    }
    const tl = await pool.query(`SELECT COUNT(*) AS c FROM reader_timelines WHERE session_id = $1`, [sid]);
    expect(Number(tl.rows[0].c)).toBe(1);
  });

  it('legacy snapshot: {} condition executes as unconditional (marker absent)', async () => {
    const snapId = await seedSnapshot('legacy', canonData({ marker: false, c1conditions: {} }));
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const r = await useCase.execute({
      sessionId: new SessionId(sid),
      readerId,
      choiceId: new ChoiceId(C1),
      expectedVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(r.version).toBe(2);
    expect(r.currentSceneId).toBe(S2);
  });

  it('legacy unparsable condition → 422, session otherwise functional', async () => {
    const snapId = await seedSnapshot('legbad', canonData({ marker: false, c1conditions: { op: 'bogus' } }));
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const err = await useCase
      .execute({
        sessionId: new SessionId(sid),
        readerId,
        choiceId: new ChoiceId(C1),
        expectedVersion: 1,
        idempotencyKey: crypto.randomUUID(),
      })
      .catch((e) => e);
    expect(err.statusCode).toBe(422);
    // Session untouched and still usable for other choices.
    const srow = await pool.query(`SELECT version FROM reader_sessions WHERE session_id = $1`, [sid]);
    expect(Number(srow.rows[0].version)).toBe(1);
  });

  it('marked unparsable mutation → 500 with zero committed writes', async () => {
    const snapId = await seedSnapshot('markbad', canonData({ c1mutations: [{ op: 'bogus', var: 'x' }] }));
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const key = crypto.randomUUID();
    const err = await useCase
      .execute({
        sessionId: new SessionId(sid),
        readerId,
        choiceId: new ChoiceId(C1),
        expectedVersion: 1,
        idempotencyKey: key,
      })
      .catch((e) => e);
    expect(err.statusCode).toBe(500);
    const tl = await pool.query(`SELECT COUNT(*) AS c FROM reader_timelines WHERE session_id = $1`, [sid]);
    expect(Number(tl.rows[0].c)).toBe(0);
    const irow = await pool.query(`SELECT COUNT(*) AS c FROM idempotency_keys WHERE idempotency_key = $1`, [key]);
    expect(Number(irow.rows[0].c)).toBe(0);
    const srow = await pool.query(`SELECT version FROM reader_sessions WHERE session_id = $1`, [sid]);
    expect(Number(srow.rows[0].version)).toBe(1);
  });

  it('cross-session same-key race: one commits, loser gets 409 (B21)', async () => {
    const snapId = await seedSnapshot('xsession', canonData({}));
    const sidA = crypto.randomUUID();
    const sidB = crypto.randomUUID();
    await seedSession(sidA, snapId);
    await seedSession(sidB, snapId);
    const key = crypto.randomUUID();
    const results = await Promise.allSettled([
      useCase.execute({ sessionId: new SessionId(sidA), readerId, choiceId: new ChoiceId(C1), expectedVersion: 1, idempotencyKey: key }),
      useCase.execute({ sessionId: new SessionId(sidB), readerId, choiceId: new ChoiceId(C1), expectedVersion: 1, idempotencyKey: key }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(IdempotencyConflictError);
    // Loser's session has no committed transition or timeline row.
    const loserSid = (fulfilled[0] as PromiseFulfilledResult<any>).value.sessionId === sidA ? sidB : sidA;
    const tl = await pool.query(`SELECT COUNT(*) AS c FROM reader_timelines WHERE session_id = $1`, [loserSid]);
    expect(Number(tl.rows[0].c)).toBe(0);
    const srow = await pool.query(`SELECT version FROM reader_sessions WHERE session_id = $1`, [loserSid]);
    expect(Number(srow.rows[0].version)).toBe(1);
  });

  it('B28: malformed sibling in marked target scene → 500, zero writes', async () => {
    const data = canonData({});
    data.choices.push({
      choice_id: crypto.randomUUID(),
      scene_id: S2,
      target_scene_id: SEND,
      text: 'Broken',
      conditions: { op: 'nope' },
      sort_order: 1,
    });
    const snapId = await seedSnapshot('b28', data);
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const key = crypto.randomUUID();
    const err = await useCase
      .execute({
        sessionId: new SessionId(sid),
        readerId,
        choiceId: new ChoiceId(C1),
        expectedVersion: 1,
        idempotencyKey: key,
      })
      .catch((e) => e);
    expect(err.statusCode).toBe(500);
    const tl = await pool.query(`SELECT COUNT(*) AS c FROM reader_timelines WHERE session_id = $1`, [sid]);
    expect(Number(tl.rows[0].c)).toBe(0);
    const srow = await pool.query(`SELECT version FROM reader_sessions WHERE session_id = $1`, [sid]);
    expect(Number(srow.rows[0].version)).toBe(1);
  });

  it('expired key + cleanup race: reuse proceeds correctly (B27)', async () => {
    const snapId = await seedSnapshot('exp', canonData({}));
    const sid = crypto.randomUUID();
    await seedSession(sid, snapId);
    const key = crypto.randomUUID();
    // Seed an expired record directly.
    await pool.query(
      `INSERT INTO idempotency_keys (idempotency_key, session_id, request_hash, response, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now() - INTERVAL '1 hour')`,
      [key, sid, '0'.repeat(64), JSON.stringify({ stale: true })]
    );
    // Concurrent cleanup + submission.
    const repo = new PostgresIdempotencyRepository();
    const [cleaned, result] = await Promise.all([
      repo.deleteExpired(),
      useCase.execute({
        sessionId: new SessionId(sid),
        readerId,
        choiceId: new ChoiceId(C1),
        expectedVersion: 1,
        idempotencyKey: key,
      }),
    ]);
    expect(cleaned).toBeGreaterThanOrEqual(0);
    expect(result.version).toBe(2);
    // Exactly one live record for the key.
    const irow = await pool.query(
      `SELECT COUNT(*) AS c FROM idempotency_keys WHERE idempotency_key = $1 AND expires_at > now()`,
      [key]
    );
    expect(Number(irow.rows[0].c)).toBe(1);
  });

  it('full-path p95 under 100ms (ADR-015 NFR-01)', async () => {
    const worldId2 = crypto.randomUUID();
    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    const c1 = crypto.randomUUID();
    const cBack = crypto.randomUUID();
    const reader2 = crypto.randomUUID();
    await pool.query(`INSERT INTO users (user_id, email, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [reader2, `perf-${Date.now()}@rene.wrld`, 'x', 'reader']);
    await pool.query(`INSERT INTO worlds (world_id, creator_id, title, status) VALUES ($1,$2,$3,'published') ON CONFLICT DO NOTHING`, [worldId2, reader2, 'Perf']);
    const canon: any = {
      canon_schema_version: 1,
      condition_grammar_version: 1,
      world: { world_id: worldId2, title: 'W', description: null, metadata: {}, start_scene_id: s1 },
      scenes: [
        { scene_id: s1, chapter_id: worldId2, title: 'S1', prose: 'p', metadata: {}, is_ending: false },
        { scene_id: s2, chapter_id: worldId2, title: 'S2', prose: 'p', metadata: {}, is_ending: false },
      ],
      choices: [
        { choice_id: c1, scene_id: s1, target_scene_id: s2, text: 'Go', mutations: [{ op: 'inc', var: 'gold', by: 1 }], sort_order: 0 },
        { choice_id: cBack, scene_id: s2, target_scene_id: s1, text: 'Back', sort_order: 0 },
      ],
    };
    const snapId = crypto.randomUUID();
    await pool.query(`INSERT INTO published_canon_snapshots (snapshot_id, world_id, version_number, canon_data) VALUES ($1,$2,$3,$4::jsonb)`, [snapId, worldId2, 1, JSON.stringify(canon)]);
    const sid = crypto.randomUUID();
    await pool.query(
      `INSERT INTO reader_sessions (session_id, reader_id, world_id, snapshot_id, current_scene_id, state_variables, version, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,1,'active')`,
      [sid, reader2, worldId2, snapId, s1, JSON.stringify({ gold: 0 })]
    );

    const latencies: number[] = [];
    let version = 1;
    for (let i = 0; i < 20; i++) {
      const choiceId = i % 2 === 0 ? c1 : cBack;
      const start = process.hrtime.bigint();
      const r = await useCase.execute({
        sessionId: new SessionId(sid),
        readerId: new UserId(reader2),
        choiceId: new ChoiceId(choiceId),
        expectedVersion: version,
        idempotencyKey: crypto.randomUUID(),
      });
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      version = r.version;
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    process.stdout.write(`Full-path submit-choice: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (n=20)\n`);
    expect(p95).toBeLessThan(100);
  });
});

