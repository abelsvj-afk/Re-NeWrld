import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type pkg from 'pg';
import { buildApp } from '../../src/app.js';
import { PasswordService } from '../../src/modules/auth/infrastructure/services/password.service.js';
import { FakeAuthRepository, FakeSessionService, FakeWorldRepository } from './helpers/test-fakes.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { Scene } from '../../src/modules/world/domain/entities/scene.entity.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { Choice } from '../../src/modules/world/domain/entities/choice.entity.js';
import { ChoiceId } from '../../src/modules/world/domain/value-objects/choice-id.value-object.js';
import { ChapterId } from '../../src/modules/world/domain/value-objects/chapter-id.value-object.js';
import { SceneRepositoryPort } from '../../src/modules/world/domain/ports/scene.repository.port.js';
import { ChoiceRepositoryPort } from '../../src/modules/world/domain/ports/choice.repository.port.js';
import { CanonRepositoryPort } from '../../src/modules/world/domain/ports/canon.repository.port.js';
import { CanonSnapshot } from '../../src/modules/world/domain/entities/canon-snapshot.entity.js';

// The publish use case calls withTransaction against a real pool; route tests
// run DB-free, so mock the transaction helper with a faithful fake.
const txCalls: string[] = [];
vi.mock('../../src/shared/database/db.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/shared/database/db.js')>();
  return {
    ...original,
    withTransaction: async <T>(fn: (client: pkg.PoolClient) => Promise<T>): Promise<T> => {
      txCalls.push('begin');
      try {
        const result = await fn({} as pkg.PoolClient);
        txCalls.push('commit');
        return result;
      } catch (err) {
        txCalls.push('rollback');
        throw err;
      }
    },
  };
});

class FakeSceneRepository implements SceneRepositoryPort {
  constructor(public scenes: Scene[] = []) {}
  async findByWorldId(worldId: WorldId): Promise<Scene[]> {
    return this.scenes.filter((s) => s.getWorldId().equals(worldId));
  }
  async findById(): Promise<Scene | null> {
    return null;
  }
  async save(): Promise<void> {}
}

class FakeChoiceRepository implements ChoiceRepositoryPort {
  constructor(public choices: Choice[] = []) {}
  async findByWorldId(worldId: WorldId): Promise<Choice[]> {
    return this.choices.filter((c) => c.getWorldId().equals(worldId));
  }
  async save(): Promise<void> {}
}

class FakeCanonRepository implements CanonRepositoryPort {
  public snapshots: CanonSnapshot[] = [];
  async nextVersion(): Promise<number> {
    return this.snapshots.length + 1;
  }
  async insert(snapshot: CanonSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }
}

function makeScene(worldId: WorldId, isEnding: boolean, sceneId?: string): Scene {
  return Scene.create({
    sceneId: new SceneId(sceneId ?? crypto.randomUUID()),
    worldId,
    chapterId: new ChapterId(crypto.randomUUID()),
    title: 'Scene',
    prose: 'Some prose.',
    metadata: {},
    isEnding,
  });
}

function makeChoice(worldId: WorldId, fromSceneId: SceneId, targetSceneId: SceneId): Choice {
  return Choice.create({
    choiceId: new ChoiceId(crypto.randomUUID()),
    worldId,
    sceneId: fromSceneId,
    targetSceneId,
    text: 'Go',
    conditions: {},
    mutations: {},
    sortOrder: 0,
  });
}

describe('POST /worlds/:id/publish (E2b)', () => {
  let authRepository: FakeAuthRepository;
  let sessionService: FakeSessionService;
  let worldRepository: FakeWorldRepository;
  let sceneRepository: FakeSceneRepository;
  let choiceRepository: FakeChoiceRepository;
  let canonRepository: FakeCanonRepository;
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

  async function seedWorld(worldId: WorldId, creatorId: UserId, startSceneId: SceneId | null): Promise<World> {
    const world = World.create({
      worldId,
      creatorId,
      title: 'Publishable World',
      description: null,
      metadata: {},
    });
    if (startSceneId) {
      world.setStartSceneId(startSceneId);
    }
    await worldRepository.save(world);
    return world;
  }

  beforeEach(() => {
    txCalls.length = 0;
    authRepository = new FakeAuthRepository();
    sessionService = new FakeSessionService(authRepository);
    worldRepository = new FakeWorldRepository();
    sceneRepository = new FakeSceneRepository();
    choiceRepository = new FakeChoiceRepository();
    canonRepository = new FakeCanonRepository();
    passwordService = new PasswordService();
  });

  async function boot() {
    return buildApp(undefined, {
      authRepository,
      sessionService,
      passwordService,
      worldRepository,
      sceneRepository,
      choiceRepository,
      canonRepository,
    });
  }

  it('201: publishes a valid world, returns snapshot id, version, and warnings', async () => {
    const app = await boot();
    const { cookie, userId } = await seedUser('creator', 'maker@rene.wrld');
    const worldId = new WorldId(crypto.randomUUID());
    const start = makeScene(worldId, false);
    const ending = makeScene(worldId, true);
    sceneRepository.scenes = [start, ending];
    choiceRepository.choices = [makeChoice(worldId, start.getSceneId(), ending.getSceneId())];
    const world = await seedWorld(worldId, userId, start.getSceneId());

    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${world.getWorldId().getValue()}/publish`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.snapshotId).toBeDefined();
    expect(body.versionNumber).toBe(1);
    expect(body.warnings).toEqual([]);
    expect(txCalls).toEqual(['begin', 'commit']);
    expect(canonRepository.snapshots).toHaveLength(1);
    expect(world.getStatus().getValue()).toBe('published');
    await app.close();
  });

  it('422: distinguishes blockers from warnings; writes nothing', async () => {
    const app = await boot();
    const { cookie, userId } = await seedUser('creator', 'maker2@rene.wrld');
    const worldId = new WorldId(crypto.randomUUID());
    const start = makeScene(worldId, false);
    const unreachableEnding = makeScene(worldId, true);
    sceneRepository.scenes = [start, unreachableEnding];
    // Dangling target (blocker) + unreachable scene (warning). No reachable ending (blocker).
    choiceRepository.choices = [
      makeChoice(worldId, start.getSceneId(), new SceneId(crypto.randomUUID())),
    ];
    const world = await seedWorld(worldId, userId, start.getSceneId());

    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${world.getWorldId().getValue()}/publish`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toContain('World failed publishing validation');
    const codes = body.report.blockers.map((b: { code: string }) => b.code);
    expect(codes).toContain('NO_REACHABLE_ENDING');
    expect(codes).toContain('DANGLING_TARGET');
    expect(body.report.warnings).toHaveLength(1);
    expect(body.report.warnings[0]).toBe(unreachableEnding.getSceneId().getValue());
    // Zero writes on validation failure.
    expect(txCalls).toEqual([]);
    expect(canonRepository.snapshots).toHaveLength(0);
    expect(world.getStatus().getValue()).toBe('draft');
    await app.close();
  });

  it('404: unknown world id and stranger creator world', async () => {
    const app = await boot();
    const { cookie } = await seedUser('creator', 'maker3@rene.wrld');
    const { userId: otherCreator } = await seedUser('creator', 'other@rene.wrld');
    const otherWorld = await seedWorld(new WorldId(crypto.randomUUID()), otherCreator, null);

    const unknown = await app.inject({
      method: 'POST',
      url: `/worlds/${crypto.randomUUID()}/publish`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);

    const strangers = await app.inject({
      method: 'POST',
      url: `/worlds/${otherWorld.getWorldId().getValue()}/publish`,
      headers: { cookie },
    });
    expect(strangers.statusCode).toBe(404);
    await app.close();
  });

  it('401: unauthenticated request is rejected', async () => {
    const app = await boot();
    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${crypto.randomUUID()}/publish`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('403: readers cannot publish', async () => {
    const app = await boot();
    const { cookie, userId } = await seedUser('reader', 'reader@rene.wrld');
    const world = await seedWorld(new WorldId(crypto.randomUUID()), userId, null);
    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${world.getWorldId().getValue()}/publish`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('400: malformed world id', async () => {
    const app = await boot();
    const { cookie } = await seedUser('creator', 'maker4@rene.wrld');
    const res = await app.inject({
      method: 'POST',
      url: '/worlds/not-a-uuid/publish',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('500: unexpected errors never leak internals', async () => {
    const { cookie, userId } = await seedUser('creator', 'maker5@rene.wrld');
    const world = await seedWorld(new WorldId(crypto.randomUUID()), userId, null);
    // Rig the scene repository to explode inside the use case.
    const explodingScenes = new FakeSceneRepository();
    explodingScenes.findByWorldId = async () => {
      throw new Error('db exploded: connection string postgresql://secret');
    };
    const app = await buildApp(undefined, {
      authRepository,
      sessionService,
      passwordService,
      worldRepository,
      sceneRepository: explodingScenes,
      choiceRepository,
      canonRepository,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/worlds/${world.getWorldId().getValue()}/publish`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('Internal Server Error');
    expect(JSON.stringify(body)).not.toContain('db exploded');
    expect(JSON.stringify(body)).not.toContain('secret');
    await app.close();
  });
});
