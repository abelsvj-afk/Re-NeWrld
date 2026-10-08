import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../scripts/migrate.js';
import { setPool, closePool } from '../../src/shared/database/db.js';
import { PostgresAuthRepository } from '../../src/modules/auth/infrastructure/persistence/postgres-auth.repository.js';
import { SessionService, SESSION_COOKIE_NAME } from '../../src/modules/auth/infrastructure/services/session.service.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

describeFn('Authentication & Session Management Integration', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connectionString: string;
  let authRepository: PostgresAuthRepository;
  let sessionService: SessionService;

  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      connectionString = container.getConnectionUri();
      process.env.DATABASE_URL = connectionString;
      setPool(connectionString);
      await runMigrations();
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

  beforeEach(() => {
    authRepository = new PostgresAuthRepository();
    sessionService = new SessionService();
  });

  it('should successfully save and retrieve a user, issue a secure session cookie config, validate session, and revoke session', async () => {
    // 1. Create domain user
    const userId = new UserId('22222222-2222-4222-8222-222222222222');
    const email = new Email('creator.test@rene.wrld');
    const role = new UserRole('creator');
    const user = User.create({
      userId,
      email,
      passwordHash: 'hashed_secure_password_123',
      role,
    });

    // 2. Save user via PostgresAuthRepository
    await authRepository.save(user);

    // 3. Verify user retrieval by ID and Email
    const foundById = await authRepository.findById(userId);
    expect(foundById).not.toBeNull();
    expect(foundById?.getEmail().getValue()).toBe('creator.test@rene.wrld');
    expect(foundById?.getRole().isCreator()).toBe(true);

    const foundByEmail = await authRepository.findByEmail(email);
    expect(foundByEmail).not.toBeNull();
    expect(foundByEmail?.getUserId().equals(userId)).toBe(true);

    // 4. Issue session via SessionService
    const { sessionId, expiresAt } = await sessionService.createSession(userId);
    expect(sessionId).toBeDefined();
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    // 5. Verify cookie options adhere to ADR-004 (HttpOnly, SameSite=Strict)
    const cookieOptions = sessionService.getCookieOptions(true);
    expect(cookieOptions.httpOnly).toBe(true);
    expect(cookieOptions.sameSite).toBe('strict');
    expect(cookieOptions.secure).toBe(true);
    expect(cookieOptions.path).toBe('/');
    expect(SESSION_COOKIE_NAME).toBe('rene_session_id');

    // 6. Validate session against server-side store
    const sessionInfo = await sessionService.validateSession(sessionId);
    expect(sessionInfo).not.toBeNull();
    expect(sessionInfo?.sessionId).toBe(sessionId);
    expect(sessionInfo?.userId.equals(userId)).toBe(true);
    expect(sessionInfo?.email.getValue()).toBe('creator.test@rene.wrld');
    expect(sessionInfo?.role.isCreator()).toBe(true);

    // 7. Revoke session and verify it no longer validates
    await sessionService.revokeSession(sessionId);
    const validatedAfterRevocation = await sessionService.validateSession(sessionId);
    expect(validatedAfterRevocation).toBeNull();
  });

  it('should revoke all user sessions correctly', async () => {
    const userId = new UserId('33333333-3333-4333-8333-333333333333');
    const email = new Email('reader.test@rene.wrld');
    const role = new UserRole('reader');
    const user = User.create({
      userId,
      email,
      passwordHash: 'hashed_reader_password',
      role,
    });

    await authRepository.save(user);

    // Create multiple sessions
    const session1 = await sessionService.createSession(userId);
    const session2 = await sessionService.createSession(userId);

    expect(await sessionService.validateSession(session1.sessionId)).not.toBeNull();
    expect(await sessionService.validateSession(session2.sessionId)).not.toBeNull();

    // Revoke all sessions for user
    await sessionService.revokeAllUserSessions(userId);

    expect(await sessionService.validateSession(session1.sessionId)).toBeNull();
    expect(await sessionService.validateSession(session2.sessionId)).toBeNull();
  });
});
