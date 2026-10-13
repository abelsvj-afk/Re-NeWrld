import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { PasswordService } from '../../src/modules/auth/infrastructure/services/password.service.js';
import { FakeAuthRepository, FakeSessionService, FakeWorldRepository } from './helpers/test-fakes.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { CanonSnapshot } from '../../src/modules/world/domain/entities/canon-snapshot.entity.js';
import { SnapshotId } from '../../src/modules/world/domain/value-objects/snapshot-id.value-object.js';
import { CanonRepositoryPort } from '../../src/modules/world/domain/ports/canon.repository.port.js';
import { SessionRepositoryPort } from '../../src/modules/session/domain/ports/session.repository.port.js';
import { SessionId } from '../../src/modules/session/domain/value-objects/session-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { ReaderSession } from '../../src/modules/session/domain/entities/reader-session.entity.js';
import type pkg from 'pg';

class FakeCanonRepository implements CanonRepositoryPort {
  public snapshots: CanonSnapshot[] = [];
  async nextVersion(): Promise<number> {
    return this.snapshots.length + 1;
  }
  async insert(snapshot: CanonSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }
  async findLatestByWorldId(worldId: WorldId): Promise<CanonSnapshot | null> {
    const matching = this.snapshots.filter((s) => s.getWorldId().equals(worldId));
    if (matching.length === 0) {
      return null;
    }
    return matching.reduce((a, b) => (a.getVersionNumber() >= b.getVersionNumber() ? a : b));
  }
}

class FakeSessionRepository implements SessionRepositoryPort {
  public sessions: ReaderSession[] = [];
  async findById(sessionId: SessionId): Promise<ReaderSession | null> {
    return this.sessions.find((s) => s.getSessionId().equals(sessionId)) ?? null;
  }
  async findByReaderId(readerId: UserId): Promise<ReaderSession[]> {
    return this.sessions.filter((s) => s.getReaderId().equals(readerId));
  }
  async save(session: ReaderSession, _tx?: pkg.PoolClient): Promise<void> {
    this.sessions.push(session);
  }
}

function makeSnapshot(worldId: WorldId, version: number, startSceneId: string): CanonSnapshot {
  return CanonSnapshot.create({
    snapshotId: SnapshotId.generate(),
    worldId,
    versionNumber: version,
    canonData: {
      canon_schema_version: 1,
      world: {
        world_id: worldId.getValue(),
        title: 'W',
        description: null,
        metadata: {},
        start_scene_id: startSceneId,
      },
      scenes: [],
      choices: [],
    },
  });
}

describe('Session routes (F1c)', () => {
  let authRepository: FakeAuthRepository;
  let sessionService: FakeSessionService;
  let worldRepository: FakeWorldRepository;
  let canonRepository: FakeCanonRepository;
  let readerSessionRepository: FakeSessionRepository;
  let passwordService: PasswordService;

  async function seedUser(role: 'creator' | 'reader', email: string): Promise<{ cookie: string; userId: UserId }> {
    const userId = new UserId(crypto.randomUUID());
    const user = User.create({
      userId,
      email: new Email(email),
      passwordHash: await passwordService.hashPassword('s3cure-password'),
      role: new UserRole(role),
    });
    await authRepository.save(user);
    const { sessionId } = await sessionService.createSession(userId);
    return { cookie: `rene_session_id=${sessionId}`, userId };
  }

  function seedWorld(worldId: WorldId, creatorId: UserId): World {
    const world = World.create({ worldId, creatorId, title: 'W', description: null, metadata: {} });
    return world;
  }

  beforeEach(() => {
    authRepository = new FakeAuthRepository();
    sessionService = new FakeSessionService(authRepository);
    worldRepository = new FakeWorldRepository();
    canonRepository = new FakeCanonRepository();
    readerSessionRepository = new FakeSessionRepository();
    passwordService = new PasswordService();
  });

  async function boot() {
    return buildApp(undefined, {
      authRepository,
      sessionService,
      passwordService,
      worldRepository,
      canonRepository,
      sessionRepository: readerSessionRepository,
    });
  }

  it('201: starts a session pinned to the latest snapshot; response exposes only public fields', async () => {
    const app = await boot();
    const { cookie } = await seedUser('reader', 'reader@rene.wrld');
    const worldId = new WorldId(crypto.randomUUID());
    const startV2 = crypto.randomUUID();
    await worldRepository.save(seedWorld(worldId, new UserId(crypto.randomUUID())));
    canonRepository.snapshots = [
      makeSnapshot(worldId, 1, crypto.randomUUID()),
      makeSnapshot(worldId, 2, startV2),
    ];

    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${worldId.getValue()}/sessions`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Exactly the five public fields — no canon_data, no internals.
    expect(Object.keys(body).sort()).toEqual(
      ['currentSceneId', 'sessionId', 'snapshotId', 'status', 'versionNumber'].sort()
    );
    expect(body.versionNumber).toBe(2);
    expect(body.currentSceneId).toBe(startV2);
    expect(body.status).toBe('active');
    expect(readerSessionRepository.sessions).toHaveLength(1);
    await app.close();
  });

  it('401: unauthenticated session creation', async () => {
    const app = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${crypto.randomUUID()}/sessions`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('403: creator role cannot start a reader session', async () => {
    const app = await boot();
    const { cookie } = await seedUser('creator', 'maker@rene.wrld');
    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${crypto.randomUUID()}/sessions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('404: unknown world', async () => {
    const app = await boot();
    const { cookie } = await seedUser('reader', 'reader2@rene.wrld');
    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${crypto.randomUUID()}/sessions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('409: world with no published snapshot', async () => {
    const app = await boot();
    const { cookie } = await seedUser('reader', 'reader3@rene.wrld');
    const worldId = new WorldId(crypto.randomUUID());
    await worldRepository.save(seedWorld(worldId, new UserId(crypto.randomUUID())));
    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${worldId.getValue()}/sessions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(readerSessionRepository.sessions).toHaveLength(0);
    await app.close();
  });

  it('400: malformed world and session ids', async () => {
    const app = await boot();
    const { cookie } = await seedUser('reader', 'reader4@rene.wrld');
    const postRes = await app.inject({
      method: 'POST',
      url: '/worlds/not-a-uuid/sessions',
      headers: { cookie },
    });
    expect(postRes.statusCode).toBe(400);
    const getRes = await app.inject({
      method: 'GET',
      url: '/sessions/not-a-uuid',
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(400);
    await app.close();
  });

  it('GET: own session readable; missing and another reader\u2019s session both 404', async () => {
    const app = await boot();
    const { cookie, userId } = await seedUser('reader', 'reader5@rene.wrld');
    const { cookie: otherCookie, userId: otherUserId } = await seedUser(
      'reader',
      'other@rene.wrld'
    );
    const worldId = new WorldId(crypto.randomUUID());
    const start = crypto.randomUUID();
    await worldRepository.save(seedWorld(worldId, new UserId(crypto.randomUUID())));
    canonRepository.snapshots = [makeSnapshot(worldId, 1, start)];

    const createRes = await app.inject({
      method: 'POST',
      url: `/worlds/${worldId.getValue()}/sessions`,
      headers: { cookie },
    });
    const sessionId = createRes.json().sessionId as string;

    const own = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}`,
      headers: { cookie },
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json();
    expect(ownBody.sessionId).toBe(sessionId);
    expect(ownBody.readerId).toBe(userId.getValue());
    expect(ownBody.version).toBe(1);
    expect(ownBody.status).toBe('active');
    // Canon data is never exposed through the session read.
    expect(ownBody.canonData).toBeUndefined();

    // Another reader's session: 404, not 403 (no existence oracle).
    const cross = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}`,
      headers: { cookie: otherCookie },
    });
    expect(cross.statusCode).toBe(404);
    expect(otherUserId.getValue()).not.toBe(userId.getValue());

    // Missing session: identical 404.
    const missing = await app.inject({
      method: 'GET',
      url: `/sessions/${crypto.randomUUID()}`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(cross.json());
    await app.close();
  });

  it('GET: terminal session remains readable by its owner', async () => {
    const app = await boot();
    const { cookie, userId } = await seedUser('reader', 'reader6@rene.wrld');
    const terminal = ReaderSession.create({
      sessionId: new SessionId(crypto.randomUUID()),
      readerId: userId,
      worldId: new WorldId(crypto.randomUUID()),
      snapshotId: new SnapshotId(crypto.randomUUID()),
      currentSceneId: new SceneId(crypto.randomUUID()),
    });
    terminal.complete();
    await readerSessionRepository.save(terminal);

    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${terminal.getSessionId().getValue()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
    await app.close();
  });
});
