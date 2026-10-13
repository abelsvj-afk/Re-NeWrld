import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../scripts/migrate.js';
import { setPool, closePool } from '../../src/shared/database/db.js';
import { PostgresAuthRepository } from '../../src/modules/auth/infrastructure/persistence/postgres-auth.repository.js';
import { SessionService, SESSION_COOKIE_NAME } from '../../src/modules/auth/infrastructure/services/session.service.js';
import { authenticate, requireCreator, requireReader, requireRole } from '../../src/shared/middleware/auth.middleware.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

describeFn('Authentication & RBAC Integration (C3 Middleware & Endpoints)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connectionString: string;
  let authRepository: PostgresAuthRepository;
  let sessionService: SessionService;
  let app: FastifyInstance;

  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      setPool(connectionString);
      await runMigrations(connectionString);
    } catch (err) {
      throw new Error(`Docker daemon / PostgreSQL container startup failed and intentional skip mechanism is not enabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  afterAll(async () => {
    try {
      await closePool();
    } catch {}
    if (container) {
      await container.stop();
    }
  });

  beforeEach(async () => {
    authRepository = new PostgresAuthRepository();
    sessionService = new SessionService();

    app = Fastify();
    const verifier = sessionService.getVerifier();

    app.get('/api/creator-only', { preHandler: [authenticate(verifier), requireCreator()] }, async () => {
      return { success: true, message: 'Welcome Creator' };
    });

    app.get('/api/reader-only', { preHandler: [authenticate(verifier), requireReader()] }, async () => {
      return { success: true, message: 'Welcome Reader' };
    });

    app.get('/api/role-creator', { preHandler: [authenticate(verifier), requireRole('creator')] }, async () => {
      return { success: true, message: 'Role Creator Verified' };
    });

    app.get('/api/role-reader', { preHandler: [authenticate(verifier), requireRole('reader')] }, async () => {
      return { success: true, message: 'Role Reader Verified' };
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return 401 when session cookie is missing or invalid', async () => {
    const resMissing = await app.inject({
      method: 'GET',
      url: '/api/creator-only',
    });
    expect(resMissing.statusCode).toBe(401);
    expect(resMissing.json()).toHaveProperty('error');

    const resInvalid = await app.inject({
      method: 'GET',
      url: '/api/creator-only',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=invalid_token_format_1234567890abcdef`,
      },
    });
    expect(resInvalid.statusCode).toBe(401);
    expect(resInvalid.json()).toHaveProperty('error');
  });

  it('should allow Creator to access Creator-only route and deny Reader with 403', async () => {
    const creatorUserId = new UserId('11111111-1111-4111-8111-111111111111');
    const creatorUser = User.create({
      userId: creatorUserId,
      email: new Email('creator.rbac@rene.wrld'),
      passwordHash: 'hash',
      role: new UserRole('creator'),
    });
    await authRepository.save(creatorUser);
    const { sessionId: creatorToken } = await sessionService.createSession(creatorUserId);

    const readerUserId = new UserId('22222222-2222-4222-8222-222222222222');
    const readerUser = User.create({
      userId: readerUserId,
      email: new Email('reader.rbac@rene.wrld'),
      passwordHash: 'hash',
      role: new UserRole('reader'),
    });
    await authRepository.save(readerUser);
    const { sessionId: readerToken } = await sessionService.createSession(readerUserId);

    // Creator accesses creator-only route -> 200 OK
    const resCreator = await app.inject({
      method: 'GET',
      url: '/api/creator-only',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${creatorToken}`,
      },
    });
    expect(resCreator.statusCode).toBe(200);
    expect(resCreator.json()).toEqual({ success: true, message: 'Welcome Creator' });

    // Reader accesses creator-only route -> 403 Forbidden
    const resReader = await app.inject({
      method: 'GET',
      url: '/api/creator-only',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${readerToken}`,
      },
    });
    expect(resReader.statusCode).toBe(403);
    expect(resReader.json()).toHaveProperty('error');
  });

  it('should allow Reader to access Reader route and deny incompatible roles with 403', async () => {
    const creatorUserId = new UserId('33333333-3333-4333-8333-333333333333');
    const creatorUser = User.create({
      userId: creatorUserId,
      email: new Email('creator.role@rene.wrld'),
      passwordHash: 'hash',
      role: new UserRole('creator'),
    });
    await authRepository.save(creatorUser);
    const { sessionId: creatorToken } = await sessionService.createSession(creatorUserId);

    const readerUserId = new UserId('44444444-4444-4444-8444-444444444444');
    const readerUser = User.create({
      userId: readerUserId,
      email: new Email('reader.role@rene.wrld'),
      passwordHash: 'hash',
      role: new UserRole('reader'),
    });
    await authRepository.save(readerUser);
    const { sessionId: readerToken } = await sessionService.createSession(readerUserId);

    // Reader accesses reader-only route -> 200 OK
    const resReader = await app.inject({
      method: 'GET',
      url: '/api/reader-only',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${readerToken}`,
      },
    });
    expect(resReader.statusCode).toBe(200);
    expect(resReader.json()).toEqual({ success: true, message: 'Welcome Reader' });

    // Creator accesses reader-only route -> 403 Forbidden
    const resCreatorOnReader = await app.inject({
      method: 'GET',
      url: '/api/reader-only',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${creatorToken}`,
      },
    });
    expect(resCreatorOnReader.statusCode).toBe(403);
    expect(resCreatorOnReader.json()).toHaveProperty('error');

    // Creator accesses role-creator -> 200 OK; Reader accesses role-creator -> 403
    const resRoleCreator = await app.inject({
      method: 'GET',
      url: '/api/role-creator',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${creatorToken}`,
      },
    });
    expect(resRoleCreator.statusCode).toBe(200);

    const resReaderOnRoleCreator = await app.inject({
      method: 'GET',
      url: '/api/role-creator',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${readerToken}`,
      },
    });
    expect(resReaderOnRoleCreator.statusCode).toBe(403);
  });
});
