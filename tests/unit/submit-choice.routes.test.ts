import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type pkg from 'pg';
import { buildApp } from '../../src/app.js';
import { FakeAuthRepository, FakeSessionService } from './helpers/test-fakes.js';
import { SessionRepositoryPort } from '../../src/modules/session/domain/ports/session.repository.port.js';
import { CanonRepositoryPort } from '../../src/modules/world/domain/ports/canon.repository.port.js';
import { IdempotencyRepositoryPort } from '../../src/modules/session/domain/ports/idempotency.repository.port.js';
import { ReaderSession } from '../../src/modules/session/domain/entities/reader-session.entity.js';
import { SessionId } from '../../src/modules/session/domain/value-objects/session-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SnapshotId } from '../../src/modules/world/domain/value-objects/snapshot-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';
import { CanonSnapshot } from '../../src/modules/world/domain/entities/canon-snapshot.entity.js';

vi.mock('../../src/shared/database/db.js', () => ({
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  query: async () => {
    throw new Error('query not mocked');
  },
}));

const READER = '11111111-1111-4111-8111-111111111111';
const WORLD = '22222222-2222-4222-8222-222222222222';
const SNAP = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4434-8444-444444444444';
const S2 = '55555555-5555-4535-8555-555555555555';
const C1 = '77777777-7777-4737-8777-777777777777';
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const KEY = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';

// Minimal fakes for the G2 route (session/canon/idempotency); auth fakes
// come from the shared helpers.
class FakeSessionRepository implements SessionRepositoryPort {
  sessions = new Map<string, ReaderSession>();
  async findById(id: SessionId) {
    const s = this.sessions.get(id.getValue());
    return s ? clone(s) : null;
  }
  async findByReaderId() {
    return [...this.sessions.values()];
  }
  async save(s: ReaderSession) {
    this.sessions.set(s.getSessionId().getValue(), s);
  }
  async findByIdForUpdate(id: SessionId, _tx: pkg.PoolClient) {
    return this.findById(id);
  }
  async persistChoiceResult(args: any, _tx: pkg.PoolClient) {
    this.sessions.set(args.session.getSessionId().getValue(), args.session);
  }
}

function clone(s: ReaderSession): ReaderSession {
  return ReaderSession.create({
    sessionId: s.getSessionId(),
    readerId: s.getReaderId(),
    worldId: s.getWorldId(),
    snapshotId: s.getSnapshotId(),
    currentSceneId: s.getCurrentSceneId(),
    stateVariables: s.getStateVariables(),
    version: s.getVersion(),
  });
}

class FakeCanonRepository implements CanonRepositoryPort {
  snapshot: CanonSnapshot | null = null;
  async nextVersion() {
    return 1;
  }
  async insert(s: CanonSnapshot) {
    this.snapshot = s;
  }
  async findLatestByWorldId() {
    return this.snapshot;
  }
  async findById(id: SnapshotId) {
    return this.snapshot && this.snapshot.getSnapshotId().equals(id) ? this.snapshot : null;
  }
}

class FakeIdempotencyRepository implements IdempotencyRepositoryPort {
  store = new Map<string, any>();
  async findUnexpiredByKey(key: string) {
    const r = this.store.get(key);
    if (!r || r.expiresAt <= new Date()) return null;
    return { ...r, isExpired: false };
  }
  async findByKeyForUpdate(key: string, _tx: pkg.PoolClient) {
    const r = this.store.get(key);
    return r ? { ...r, isExpired: r.expiresAt <= new Date() } : null;
  }
  async insert(rec: any, _tx: pkg.PoolClient) {
    this.store.set(rec.idempotencyKey, { ...rec, expiresAt: new Date(Date.now() + 86400000) });
  }
  async deleteByKey(key: string, _tx: pkg.PoolClient) {
    this.store.delete(key);
  }
  async deleteExpired() {
    return 0;
  }
}

function makeSnapshot(): CanonSnapshot {
  return CanonSnapshot.create({
    snapshotId: new SnapshotId(SNAP),
    worldId: new WorldId(WORLD),
    versionNumber: 1,
    canonData: {
      canon_schema_version: 1,
      condition_grammar_version: 1,
      world: { world_id: WORLD, title: 'W', description: null, metadata: {}, start_scene_id: S1 },
      scenes: [
        { scene_id: S1, chapter_id: WORLD, title: 'S1', prose: 'p', metadata: {}, is_ending: false },
        { scene_id: S2, chapter_id: WORLD, title: 'S2', prose: 'p', metadata: {}, is_ending: false },
      ],
      choices: [
        {
          choice_id: C1,
          scene_id: S1,
          target_scene_id: S2,
          text: 'Go',
          mutations: [{ op: 'inc', var: 'gold', by: 5 }],
          sort_order: 0,
        },
      ],
    } as any,
  });
}

describe('POST /sessions/:id/choices (G2d)', () => {
  let sessionRepository: FakeSessionRepository;
  let canonRepository: FakeCanonRepository;

  async function boot() {
    const authRepository = new FakeAuthRepository();
    const sessionService = new FakeSessionService(authRepository);
    // Seed a reader user + login session (cookie auth).
    const userId = new UserId(READER);
    await authRepository.save(
      User.create({
        userId,
        email: new Email('reader@rene.wrld'),
        passwordHash: 'x',
        role: new UserRole('reader'),
      })
    );
    const { sessionId } = await sessionService.createSession(userId);
    const cookie = `rene_session_id=${sessionId}`;
    sessionRepository = new FakeSessionRepository();
    canonRepository = new FakeCanonRepository();
    canonRepository.snapshot = makeSnapshot();
    sessionRepository.sessions.set(
      SESSION,
      ReaderSession.create({
        sessionId: new SessionId(SESSION),
        readerId: new UserId(READER),
        worldId: new WorldId(WORLD),
        snapshotId: new SnapshotId(SNAP),
        currentSceneId: new SceneId(S1),
        stateVariables: { gold: 10 },
        version: 1,
      })
    );
    const app = await buildApp(undefined, {
      authRepository: authRepository as any,
      sessionService: sessionService as any,
      sessionRepository: sessionRepository as any,
      canonRepository: canonRepository as any,
      idempotencyRepository: new FakeIdempotencyRepository() as any,
      worldRepository: {} as any,
    });
    return { app, cookie };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200: submits a choice, exact response shape', async () => {
    const { app, cookie } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${SESSION}/choices`,
      headers: { cookie, 'x-idempotency-key': KEY },
      payload: { choiceId: C1, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: SESSION,
      version: 2,
      currentSceneId: S2,
      status: 'active',
      appliedMutations: [{ op: 'inc', var: 'gold', value: 15 }],
      availableChoices: [],
    });
  });

  it('401: without auth', async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${SESSION}/choices`,
      headers: { 'x-idempotency-key': KEY },
      payload: { choiceId: C1, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400: missing X-Idempotency-Key', async () => {
    const { app, cookie } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${SESSION}/choices`,
      headers: { cookie },
      payload: { choiceId: C1, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400: malformed X-Idempotency-Key', async () => {
    const { app, cookie } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${SESSION}/choices`,
      headers: { cookie, 'x-idempotency-key': 'not-a-uuid' },
      payload: { choiceId: C1, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400: invalid body', async () => {
    const { app, cookie } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${SESSION}/choices`,
      headers: { cookie, 'x-idempotency-key': KEY },
      payload: { choiceId: 'nope', expectedVersion: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404: unknown session', async () => {
    const { app, cookie } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/aaaaaaaa-bbbb-4ccc-8ddd-000000000099/choices`,
      headers: { cookie, 'x-idempotency-key': KEY },
      payload: { choiceId: C1, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('409: version mismatch carries report.currentVersion', async () => {
    const { app, cookie } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${SESSION}/choices`,
      headers: { cookie, 'x-idempotency-key': KEY },
      payload: { choiceId: C1, expectedVersion: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().report).toEqual({ currentVersion: 1 });
  });

  it('500: 5xx messages are generic (CanonInvariantError hidden)', async () => {
    const { app, cookie } = await boot();
    // Corrupt the snapshot: marked canon with an unparsable condition.
    const bad = makeSnapshot();
    (bad.getCanonData() as any).choices[0].conditions = { op: 'bogus' };
    canonRepository.snapshot = bad;
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${SESSION}/choices`,
      headers: { cookie, 'x-idempotency-key': KEY },
      payload: { choiceId: C1, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('Internal Server Error');
  });
});
