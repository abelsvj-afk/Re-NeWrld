import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import pkg from 'pg';
const { Pool } = pkg;
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../scripts/migrate.js';
import { setPool, closePool, query } from '../../src/shared/database/db.js';
import { PostgresAuthRepository } from '../../src/modules/auth/infrastructure/persistence/postgres-auth.repository.js';
import { SessionService, SESSION_COOKIE_NAME, SessionVerifier, cookieSecureForEnv } from '../../src/modules/auth/infrastructure/services/session.service.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

describeFn('Authentication & Session Management Integration (C2 Secure Hashing & Verification)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connectionString: string;
  let authRepository: PostgresAuthRepository;
  let sessionService: SessionService;

  beforeAll(async () => {
    try {
      // TEST_DATABASE_URL: run against a real, externally-managed PostgreSQL
      // (e.g. a local install) instead of Testcontainers. Same tests against
      // the same real database engine — only the provisioning differs.
      const externalUrl = process.env.TEST_DATABASE_URL;
      if (externalUrl) {
        connectionString = externalUrl;
      } else {
        container = await new PostgreSqlContainer('postgres:15-alpine').start();
        connectionString = container.getConnectionUri();
      }
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

  beforeEach(() => {
    authRepository = new PostgresAuthRepository();
    sessionService = new SessionService();
  });

  it('should store only SHA-256 hash in DB matching sha256(raw), never raw token, and validate/revoke successfully without exposing raw token in SessionInfo', async () => {
    const userId = new UserId(crypto.randomUUID());
    const email = new Email(`creator-${userId.getValue()}@rene.wrld`);
    const role = new UserRole('creator');
    const user = User.create({
      userId,
      email,
      passwordHash: 'hashed_secure_password_123',
      role,
    });

    await authRepository.save(user);

    // 1. Create session and verify raw token returned
    const { sessionId: rawToken, expiresAt } = await sessionService.createSession(userId);
    expect(rawToken).toBeDefined();
    expect(typeof rawToken).toBe('string');
    expect(rawToken.length).toBeGreaterThan(30);

    // 2. Check DB directly: stored hash equals sha256(raw)
    const dbResult = await query<{ token_hash: string }>(
      `SELECT token_hash FROM auth_sessions WHERE user_id = $1`,
      [userId.getValue()]
    );
    expect(dbResult.rowCount).toBe(1);
    const storedHash = dbResult.rows[0].token_hash;
    const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    expect(storedHash).toBe(expectedHash);
    expect(storedHash).not.toBe(rawToken);

    // 3. Table test over all four APP_ENV values for cookieSecureForEnv and maxAge assertion
    const appEnvs = ['development', 'test', 'staging', 'production'] as const;
    const expectedSecures = [false, false, true, true];

    appEnvs.forEach((appEnv, idx) => {
      const secure = cookieSecureForEnv(appEnv);
      expect(secure).toBe(expectedSecures[idx]);
      const opts = sessionService.getCookieOptions(secure, expiresAt);
      expect(opts.secure).toBe(expectedSecures[idx]);
      expect(opts.maxAge).toBeDefined();
      expect(opts.maxAge).toBeGreaterThanOrEqual(604790);
      expect(opts.maxAge).toBeLessThanOrEqual(604810);
    });

    expect(SESSION_COOKIE_NAME).toBe('rene_session_id');

    // 4. Validate session using raw token; verify SessionInfo contains metadata but NOT raw token
    const sessionInfo = await sessionService.validateSession(rawToken);
    expect(sessionInfo).not.toBeNull();
    expect(sessionInfo?.userId.equals(userId)).toBe(true);
    expect((sessionInfo as any).sessionId).toBeUndefined();

    // 5. Test SessionVerifier injection type
    const verifier: SessionVerifier = sessionService.getVerifier();
    const verifiedInfo = await verifier(rawToken);
    expect(verifiedInfo).not.toBeNull();
    expect(verifiedInfo?.userId.equals(userId)).toBe(true);

    // 6. Revoke session and verify null
    await sessionService.revokeSession(rawToken);
    expect(await sessionService.validateSession(rawToken)).toBeNull();
  });

  it('should return null without throwing on malformed tokens, but safe no-op on malformed revoke', async () => {
    const malformedTokens = [
      null as any,
      undefined as any,
      '',
      '   ',
      'abc', // too short (<32 chars)
      'A'.repeat(43) + '!', // 43-char string containing '!' (invalid base64url charset)
      'sql\' OR \'1\'=\'1', // SQL injection string
      'A'.repeat(10000), // 10,000-char string (exceeding length bounds)
      12345 as any,
    ];

    for (const token of malformedTokens) {
      await expect(sessionService.validateSession(token)).resolves.toBeNull();
      await expect(sessionService.revokeSession(token)).resolves.toBeUndefined();
    }
  });

  it('should propagate database query failure as operational error during validation instead of returning null', async () => {
    const adminPool = new Pool({ connectionString });
    const errDbName = `auth_err_db_${Date.now()}`;
    let testError: unknown;
    let dbCreated = false;
    try {
      await adminPool.query(`CREATE DATABASE ${errDbName};`);
      dbCreated = true;
      const errDbUrl = connectionString.replace(/\/[^/]+$/, `/${errDbName}`);
      setPool(errDbUrl);
      await runMigrations(errDbUrl);

      // Perform destructive operation in the isolated disposable database
      await query(`DROP TABLE auth_sessions CASCADE;`);
      const validRawToken = crypto.randomBytes(32).toString('base64url');
      await expect(sessionService.validateSession(validRawToken)).rejects.toThrow();
    } catch (err) {
      testError = err;
    } finally {
      setPool(connectionString);
      let cleanupError: unknown;
      if (dbCreated) {
        try {
          await adminPool.query(`DROP DATABASE IF EXISTS ${errDbName} WITH (FORCE);`);
        } catch (err) {
          cleanupError = err;
        }
      }
      try {
        await adminPool.end();
      } catch (err) {
        if (!cleanupError) cleanupError = err;
      }

      if (testError) {
        if (cleanupError) {
          console.error('Cleanup error during test failure:', cleanupError);
        }
        throw testError;
      }
      if (cleanupError) {
        throw cleanupError;
      }
    }
  });

  it('should propagate database query failure as operational error during revocation instead of swallowing', async () => {
    const adminPool = new Pool({ connectionString });
    const errDbName = `auth_err_db_rev_${Date.now()}`;
    let testError: unknown;
    let dbCreated = false;
    try {
      await adminPool.query(`CREATE DATABASE ${errDbName};`);
      dbCreated = true;
      const errDbUrl = connectionString.replace(/\/[^/]+$/, `/${errDbName}`);
      setPool(errDbUrl);
      await runMigrations(errDbUrl);

      // Perform destructive operation in the isolated disposable database
      await query(`DROP TABLE auth_sessions CASCADE;`);
      const validRawToken = crypto.randomBytes(32).toString('base64url');
      await expect(sessionService.revokeSession(validRawToken)).rejects.toThrow();
    } catch (err) {
      testError = err;
    } finally {
      setPool(connectionString);
      let cleanupError: unknown;
      if (dbCreated) {
        try {
          await adminPool.query(`DROP DATABASE IF EXISTS ${errDbName} WITH (FORCE);`);
        } catch (err) {
          cleanupError = err;
        }
      }
      try {
        await adminPool.end();
      } catch (err) {
        if (!cleanupError) cleanupError = err;
      }

      if (testError) {
        if (cleanupError) {
          console.error('Cleanup error during test failure:', cleanupError);
        }
        throw testError;
      }
      if (cleanupError) {
        throw cleanupError;
      }
    }
  });

  it('should return null for expired sessions (negative duration)', async () => {
    const userId = new UserId('44444444-4444-4444-8444-444444444444');
    const user = User.create({
      userId,
      email: new Email('expired.test@rene.wrld'),
      passwordHash: 'hash',
      role: new UserRole('reader'),
    });
    await authRepository.save(user);

    // Create session with negative duration (-1 hour)
    const { sessionId: rawToken } = await sessionService.createSession(userId, -3600000);

    const sessionInfo = await sessionService.validateSession(rawToken);
    expect(sessionInfo).toBeNull();
  });
});
