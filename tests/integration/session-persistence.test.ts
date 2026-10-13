import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pkg from 'pg';
import { setPool, closePool } from '../../src/shared/database/db.js';
import { runMigrations } from '../../scripts/migrate.js';
import { PostgresSessionRepository } from '../../src/modules/session/infrastructure/persistence/postgres-session.repository.js';
import { ReaderSession } from '../../src/modules/session/domain/entities/reader-session.entity.js';
import { SessionId } from '../../src/modules/session/domain/value-objects/session-id.value-object.js';
import { SessionStatus } from '../../src/modules/session/domain/value-objects/session-status.value-object.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { SnapshotId } from '../../src/modules/world/domain/value-objects/snapshot-id.value-object.js';
import { ChoiceId } from '../../src/modules/world/domain/value-objects/choice-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import {
  SessionNotFoundError,
  SessionVersionConflictError,
  IllegalSessionTransitionError,
} from '../../src/modules/session/domain/errors/session.errors.js';

const { Pool } = pkg;

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

// Authoritative persistence tests for Task F2a. VERIFIED 2026-10-13 against
// real PostgreSQL 16.2 (local install via TEST_DATABASE_URL; Testcontainers
// path unchanged as the default). All 8 tests passed.
describeFn('Session atomic transitions (F2a)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: pkg.Pool;
  let repo: PostgresSessionRepository;
  const readerId = new UserId(crypto.randomUUID());
  const worldId = new WorldId(crypto.randomUUID());
  const snapshotId = new SnapshotId(crypto.randomUUID());
  const startSceneId = new SceneId(crypto.randomUUID());

  beforeAll(async () => {
    // TEST_DATABASE_URL: run against a real, externally-managed PostgreSQL
    // (e.g. a local install) instead of Testcontainers. Same tests against
    // the same real database engine — only the provisioning differs.
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
    repo = new PostgresSessionRepository();

    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [readerId.getValue(), `f2a-${readerId.getValue()}@reader.test`, 'hash', 'reader']
    );
    const creatorId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [creatorId, `f2a-creator-${creatorId}@test`, 'hash', 'creator']
    );
    await pool.query(
      `INSERT INTO worlds (world_id, creator_id, title, description, metadata, status)
       VALUES ($1, $2, 'F2a World', NULL, '{}', 'published') ON CONFLICT DO NOTHING`,
      [worldId.getValue(), creatorId]
    );
    // reader_sessions.snapshot_id references published_canon_snapshots.
    await pool.query(
      `INSERT INTO published_canon_snapshots (snapshot_id, world_id, version_number, canon_data)
       VALUES ($1, $2, 1, $3) ON CONFLICT DO NOTHING`,
      [
        snapshotId.getValue(),
        worldId.getValue(),
        JSON.stringify({
          canon_schema_version: 1,
          world: {
            world_id: worldId.getValue(),
            title: 'F2a World',
            description: null,
            metadata: {},
            start_scene_id: startSceneId.getValue(),
          },
          scenes: [],
          choices: [],
        }),
      ]
    );
  });

  afterAll(async () => {
    await closePool().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

  async function seedSession(overrides: { status?: SessionStatus; state?: Record<string, unknown> } = {}): Promise<ReaderSession> {
    const session = ReaderSession.create({
      sessionId: SessionId.generate(),
      readerId,
      worldId,
      snapshotId,
      currentSceneId: startSceneId,
      stateVariables: overrides.state ?? { gold: 10 },
      status: overrides.status,
    });
    await repo.save(session);
    return session;
  }

  async function timelineRows(sessionId: SessionId): Promise<Array<{ sequence_number: number }>> {
    const res = await pool.query(
      `SELECT sequence_number FROM reader_timelines WHERE session_id = $1 ORDER BY sequence_number`,
      [sessionId.getValue()]
    );
    return res.rows;
  }

  it('applies a transition atomically: session updated and timeline appended', async () => {
    const session = await seedSession();
    const toScene = new SceneId(crypto.randomUUID());
    const choiceId = new ChoiceId(crypto.randomUUID());

    const updated = await repo.applyTransition({
      sessionId: session.getSessionId(),
      expectedVersion: 1,
      toSceneId: toScene,
      stateDiff: { gold: 5 },
      choiceId,
    });

    expect(updated.getVersion()).toBe(2);
    expect(updated.getCurrentSceneId().equals(toScene)).toBe(true);
    expect(updated.getStateVariables()).toEqual({ gold: 5 });

    const reloaded = await repo.findById(session.getSessionId());
    expect(reloaded?.getVersion()).toBe(2);

    const rows = await pool.query(
      `SELECT sequence_number, from_scene_id, to_scene_id, choice_id, state_diff
       FROM reader_timelines WHERE session_id = $1`,
      [session.getSessionId().getValue()]
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].sequence_number).toBe(1);
    expect(rows.rows[0].from_scene_id).toBe(startSceneId.getValue());
    expect(rows.rows[0].to_scene_id).toBe(toScene.getValue());
    expect(rows.rows[0].choice_id).toBe(choiceId.getValue());
    expect(rows.rows[0].state_diff).toEqual({ gold: 5 });
  });

  it('appends gapless sequences across successive transitions', async () => {
    const session = await seedSession();
    for (let i = 0; i < 3; i++) {
      await repo.applyTransition({
        sessionId: session.getSessionId(),
        expectedVersion: i + 1,
        toSceneId: new SceneId(crypto.randomUUID()),
        stateDiff: { step: i },
        choiceId: new ChoiceId(crypto.randomUUID()),
      });
    }
    const rows = await timelineRows(session.getSessionId());
    expect(rows.map((r) => r.sequence_number)).toEqual([1, 2, 3]);
  });

  it('stale expected version → 409 with currentVersion; no partial writes', async () => {
    const session = await seedSession();
    const err = await repo
      .applyTransition({
        sessionId: session.getSessionId(),
        expectedVersion: 999,
        toSceneId: new SceneId(crypto.randomUUID()),
        stateDiff: {},
        choiceId: new ChoiceId(crypto.randomUUID()),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SessionVersionConflictError);
    expect(err.statusCode).toBe(409);
    expect(err.report).toEqual({ currentVersion: 1 });

    const reloaded = await repo.findById(session.getSessionId());
    expect(reloaded?.getVersion()).toBe(1);
    expect(reloaded?.getStateVariables()).toEqual({ gold: 10 });
    expect(await timelineRows(session.getSessionId())).toHaveLength(0);
  });

  it('entity validation failure rolls back: terminal session writes nothing', async () => {
    const session = await seedSession({ status: new SessionStatus('completed') });
    const err = await repo
      .applyTransition({
        sessionId: session.getSessionId(),
        expectedVersion: 1,
        toSceneId: new SceneId(crypto.randomUUID()),
        stateDiff: {},
        choiceId: new ChoiceId(crypto.randomUUID()),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(IllegalSessionTransitionError);

    const reloaded = await repo.findById(session.getSessionId());
    expect(reloaded?.getStatus().getValue()).toBe('completed');
    expect(await timelineRows(session.getSessionId())).toHaveLength(0);
  });

  it('unknown session → 404', async () => {
    const err = await repo
      .applyTransition({
        sessionId: new SessionId(crypto.randomUUID()),
        expectedVersion: 1,
        toSceneId: new SceneId(crypto.randomUUID()),
        stateDiff: {},
        choiceId: new ChoiceId(crypto.randomUUID()),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SessionNotFoundError);
    expect(err.statusCode).toBe(404);
  });

  it('caller-supplied tx: repository never commits; outer rollback persists nothing', async () => {
    const session = await seedSession();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await repo.applyTransition(
        {
          sessionId: session.getSessionId(),
          expectedVersion: 1,
          toSceneId: new SceneId(crypto.randomUUID()),
          stateDiff: { gold: 1 },
          choiceId: new ChoiceId(crypto.randomUUID()),
        },
        client
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const reloaded = await repo.findById(session.getSessionId());
    expect(reloaded?.getVersion()).toBe(1);
    expect(await timelineRows(session.getSessionId())).toHaveLength(0);
  });

  it('timeline insert failure rolls back the session update (failure injection)', async () => {
    const session = await seedSession();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Sabotage only the timeline INSERT: every other statement runs for
      // real against the database. This deterministically exercises the
      // "insert fails after the session UPDATE" path without changing
      // production code.
      const sabotaged = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === 'query') {
            return async (text: string, params?: unknown[]) => {
              if (text.includes('INSERT INTO reader_timelines')) {
                throw new Error('injected timeline insert failure');
              }
              return target.query(text, params as unknown[]);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as pkg.PoolClient;

      const err = await repo
        .applyTransition(
          {
            sessionId: session.getSessionId(),
            expectedVersion: 1,
            toSceneId: new SceneId(crypto.randomUUID()),
            stateDiff: { gold: 1 },
            choiceId: new ChoiceId(crypto.randomUUID()),
          },
          sabotaged
        )
        .catch((e) => e);
      // The injected insert error propagates (not swallowed or remapped).
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('injected timeline insert failure');

      await client.query('ROLLBACK');

      // The session UPDATE was rolled back together with the failed insert.
      const reloaded = await repo.findById(session.getSessionId());
      expect(reloaded?.getVersion()).toBe(1);
      expect(reloaded?.getStateVariables()).toEqual({ gold: 10 });
      expect(await timelineRows(session.getSessionId())).toHaveLength(0);
    } finally {
      // Defensive cleanup: never leave the transaction open.
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('concurrent same-version transitions: exactly one wins, the other gets 409', async () => {
    const session = await seedSession();
    const args = {
      sessionId: session.getSessionId(),
      expectedVersion: 1,
      choiceId: new ChoiceId(crypto.randomUUID()),
      stateDiff: { raced: true },
    };
    const results = await Promise.allSettled([
      repo.applyTransition({ ...args, toSceneId: new SceneId(crypto.randomUUID()) }),
      repo.applyTransition({ ...args, toSceneId: new SceneId(crypto.randomUUID()) }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejection).toBeInstanceOf(SessionVersionConflictError);
    expect(rejection.report).toEqual({ currentVersion: 2 });

    const rows = await timelineRows(session.getSessionId());
    expect(rows.map((r) => r.sequence_number)).toEqual([1]);
  });
});
