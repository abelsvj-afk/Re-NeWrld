import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { PasswordService } from '../../src/modules/auth/infrastructure/services/password.service.js';
import { FakeAuthRepository, FakeSessionService, FakeWorldRepository } from './helpers/test-fakes.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';

describe('World HTTP routes (creator-only)', () => {
  let authRepository: FakeAuthRepository;
  let sessionService: FakeSessionService;
  let worldRepository: FakeWorldRepository;
  let passwordService: PasswordService;

  async function seedUser(role: 'creator' | 'reader', email: string): Promise<string> {
    const userId = new UserId(crypto.randomUUID());
    const user = User.create({
      userId,
      email: new Email(email),
      passwordHash: await passwordService.hashPassword('s3cure-password'),
      role: new UserRole(role),
    });
    await authRepository.save(user);
    const { sessionId } = await sessionService.createSession(userId);
    return `rene_session_id=${sessionId}`;
  }

  beforeEach(() => {
    authRepository = new FakeAuthRepository();
    sessionService = new FakeSessionService(authRepository);
    worldRepository = new FakeWorldRepository();
    passwordService = new PasswordService();
  });

  async function boot() {
    return buildApp(undefined, { authRepository, sessionService, passwordService, worldRepository });
  }

  it('POST /worlds creates a world for a creator (201)', async () => {
    const app = await boot();
    const cookie = await seedUser('creator', 'maker@rene.wrld');
    const res = await app.inject({
      method: 'POST',
      url: '/worlds',
      headers: { cookie },
      payload: { title: 'My First World', description: 'A test world' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.title).toBe('My First World');
    expect(body.status).toBe('draft');
    expect(body.id).toBeDefined();
    await app.close();
  });

  it('POST /worlds rejects readers with 403 and strangers with 401', async () => {
    const app = await boot();
    const readerCookie = await seedUser('reader', 'reader@rene.wrld');
    const forbidden = await app.inject({
      method: 'POST',
      url: '/worlds',
      headers: { cookie: readerCookie },
      payload: { title: 'Nope' },
    });
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'POST',
      url: '/worlds',
      payload: { title: 'Nope' },
    });
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });

  it('POST /worlds validates input with 400 (empty title, oversized metadata)', async () => {
    const app = await boot();
    const cookie = await seedUser('creator', 'maker2@rene.wrld');
    const emptyTitle = await app.inject({
      method: 'POST',
      url: '/worlds',
      headers: { cookie },
      payload: { title: '' },
    });
    expect(emptyTitle.statusCode).toBe(400);
    const deepMetadata = await app.inject({
      method: 'POST',
      url: '/worlds',
      headers: { cookie },
      payload: { title: 'Deep', metadata: { a: { b: { c: { d: 'too-deep' } } } } },
    });
    expect(deepMetadata.statusCode).toBe(400);
    await app.close();
  });

  it('GET /worlds lists only the caller\u2019s worlds; GET /worlds/:id hides others\u2019 worlds with 404', async () => {
    const app = await boot();
    const cookieA = await seedUser('creator', 'a@rene.wrld');
    const cookieB = await seedUser('creator', 'b@rene.wrld');

    const created = await app.inject({
      method: 'POST',
      url: '/worlds',
      headers: { cookie: cookieA },
      payload: { title: 'A World' },
    });
    const worldId = created.json().id;

    const listB = await app.inject({ method: 'GET', url: '/worlds', headers: { cookie: cookieB } });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().worlds).toHaveLength(0);

    // Creator B cannot see creator A's world: 404, not 403 (no ID oracle)
    const crossGet = await app.inject({
      method: 'GET',
      url: `/worlds/${worldId}`,
      headers: { cookie: cookieB },
    });
    expect(crossGet.statusCode).toBe(404);

    const ownGet = await app.inject({
      method: 'GET',
      url: `/worlds/${worldId}`,
      headers: { cookie: cookieA },
    });
    expect(ownGet.statusCode).toBe(200);
    expect(ownGet.json().title).toBe('A World');
    await app.close();
  });

  it('GET /worlds/:id returns 400 for malformed ids and 404 for unknown ids', async () => {
    const app = await boot();
    const cookie = await seedUser('creator', 'c@rene.wrld');
    const malformed = await app.inject({
      method: 'GET',
      url: '/worlds/not-a-uuid',
      headers: { cookie },
    });
    expect(malformed.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'GET',
      url: `/worlds/${new WorldId(crypto.randomUUID()).getValue()}`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /worlds/:id updates title and metadata', async () => {
    const app = await boot();
    const cookie = await seedUser('creator', 'd@rene.wrld');
    const created = await app.inject({
      method: 'POST',
      url: '/worlds',
      headers: { cookie },
      payload: { title: 'Before' },
    });
    const worldId = created.json().id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/worlds/${worldId}`,
      headers: { cookie },
      payload: { title: 'After', metadata: { genre: 'fantasy' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().title).toBe('After');
    expect(patched.json().metadata).toEqual({ genre: 'fantasy' });
    await app.close();
  });
});
