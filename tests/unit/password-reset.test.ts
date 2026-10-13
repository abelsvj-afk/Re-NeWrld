import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { PasswordService } from '../../src/modules/auth/infrastructure/services/password.service.js';
import { PasswordResetToken } from '../../src/modules/auth/domain/entities/password-reset-token.entity.js';
import { RequestPasswordResetUseCase } from '../../src/modules/auth/application/request-password-reset.use-case.js';
import { ConfirmPasswordResetUseCase } from '../../src/modules/auth/application/confirm-password-reset.use-case.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';
import {
  FakeAuthRepository,
  FakeSessionService,
  FakePasswordResetRepository,
  FakeEmailService,
} from './helpers/test-fakes.js';

describe('PasswordResetToken entity', () => {
  it('issues a consumable token with a 64-char SHA-256 hash', () => {
    const { rawToken, token } = PasswordResetToken.issue(new UserId(crypto.randomUUID()));
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.getTokenHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(token.isConsumable()).toBe(true);
    expect(token.isUsed()).toBe(false);
    expect(token.isExpired()).toBe(false);
  });

  it('hashRawToken is deterministic and matches the issued hash', () => {
    const { rawToken, token } = PasswordResetToken.issue(new UserId(crypto.randomUUID()));
    expect(PasswordResetToken.hashRawToken(rawToken)).toBe(token.getTokenHash());
  });

  it('markUsed flips consumability; double-use throws', () => {
    const { token } = PasswordResetToken.issue(new UserId(crypto.randomUUID()));
    token.markUsed();
    expect(token.isUsed()).toBe(true);
    expect(token.isConsumable()).toBe(false);
    expect(() => token.markUsed()).toThrow();
  });

  it('detects expiry (15-minute TTL)', () => {
    const old = new Date(Date.now() - 20 * 60 * 1000);
    const { token } = PasswordResetToken.issue(new UserId(crypto.randomUUID()), old);
    expect(token.isExpired()).toBe(true);
    expect(token.isConsumable()).toBe(false);
  });
});

describe('RequestPasswordResetUseCase', () => {
  let authRepository: FakeAuthRepository;
  let resetRepository: FakePasswordResetRepository;
  let emailService: FakeEmailService;
  let passwordService: PasswordService;
  let useCase: RequestPasswordResetUseCase;

  beforeEach(async () => {
    authRepository = new FakeAuthRepository();
    resetRepository = new FakePasswordResetRepository();
    emailService = new FakeEmailService();
    passwordService = new PasswordService();
    useCase = new RequestPasswordResetUseCase(authRepository, resetRepository, emailService, passwordService);

    const user = User.create({
      userId: new UserId(crypto.randomUUID()),
      email: new Email('reader@rene.wrld'),
      passwordHash: await passwordService.hashPassword('old-password-1'),
      role: new UserRole('reader'),
    });
    await authRepository.save(user);
  });

  it('sends a reset email and stores only the token hash for a known email', async () => {
    await useCase.execute({ email: 'reader@rene.wrld' });
    expect(emailService.sent).toHaveLength(1);
    expect(emailService.sent[0].to).toBe('reader@rene.wrld');
    expect(resetRepository.stored).toHaveLength(1);
    const stored = resetRepository.stored[0];
    // The raw token is never persisted — only its hash.
    expect(stored.getTokenHash()).not.toContain(emailService.sent[0].rawToken);
    expect(stored.getTokenHash()).toBe(PasswordResetToken.hashRawToken(emailService.sent[0].rawToken));
  });

  it('resolves silently for an unknown email: no email, no token (anti-enumeration)', async () => {
    await useCase.execute({ email: 'nobody@rene.wrld' });
    expect(emailService.sent).toHaveLength(0);
    expect(resetRepository.stored).toHaveLength(0);
  });

  it('rejects malformed email addresses', async () => {
    await expect(useCase.execute({ email: 'not-an-email' })).rejects.toThrow();
  });
});

describe('ConfirmPasswordResetUseCase', () => {
  let authRepository: FakeAuthRepository;
  let resetRepository: FakePasswordResetRepository;
  let sessionService: FakeSessionService;
  let passwordService: PasswordService;
  let emailService: FakeEmailService;
  let requestUseCase: RequestPasswordResetUseCase;
  let confirmUseCase: ConfirmPasswordResetUseCase;
  let userId: UserId;

  beforeEach(async () => {
    authRepository = new FakeAuthRepository();
    resetRepository = new FakePasswordResetRepository();
    sessionService = new FakeSessionService(authRepository);
    passwordService = new PasswordService();
    emailService = new FakeEmailService();
    requestUseCase = new RequestPasswordResetUseCase(authRepository, resetRepository, emailService, passwordService);
    confirmUseCase = new ConfirmPasswordResetUseCase(authRepository, resetRepository, sessionService, passwordService);

    userId = new UserId(crypto.randomUUID());
    const user = User.create({
      userId,
      email: new Email('reader@rene.wrld'),
      passwordHash: await passwordService.hashPassword('old-password-1'),
      role: new UserRole('reader'),
    });
    await authRepository.save(user);
  });

  async function freshToken(): Promise<string> {
    await requestUseCase.execute({ email: 'reader@rene.wrld' });
    return emailService.sent[emailService.sent.length - 1].rawToken;
  }

  it('resets the password, consumes the token, and revokes all sessions', async () => {
    const { sessionId } = await sessionService.createSession(userId);
    const rawToken = await freshToken();

    await confirmUseCase.execute({ token: rawToken, newPassword: 'brand-new-password-2' });

    const user = await authRepository.findByEmail(new Email('reader@rene.wrld'));
    expect(user).not.toBeNull();
    expect(await passwordService.verifyPassword('brand-new-password-2', user!.getPasswordHash())).toBe(true);
    expect(await passwordService.verifyPassword('old-password-1', user!.getPasswordHash())).toBe(false);
    // Token consumed.
    expect(resetRepository.stored[0].isUsed()).toBe(true);
    // All sessions revoked — the pre-reset session no longer validates.
    expect(await sessionService.validateSession(sessionId)).toBeNull();
  });

  it('rejects token reuse with a generic 400', async () => {
    const rawToken = await freshToken();
    await confirmUseCase.execute({ token: rawToken, newPassword: 'brand-new-password-2' });
    await expect(confirmUseCase.execute({ token: rawToken, newPassword: 'another-password-3' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects malformed tokens with a generic 400', async () => {
    await expect(confirmUseCase.execute({ token: 'garbage', newPassword: 'brand-new-password-2' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects well-formed but unknown tokens with a generic 400', async () => {
    const unknown = crypto.randomBytes(32).toString('base64url');
    await expect(confirmUseCase.execute({ token: unknown, newPassword: 'brand-new-password-2' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects expired tokens with a generic 400', async () => {
    // Issue a token, then backdate its expiry via rehydration (raw value kept).
    const issued = PasswordResetToken.issue(userId);
    const expired = PasswordResetToken.rehydrate({
      tokenHash: issued.token.getTokenHash(),
      userId,
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    await resetRepository.save(expired);
    await expect(
      confirmUseCase.execute({ token: issued.rawToken, newPassword: 'brand-new-password-2' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Password reset HTTP routes', () => {
  let authRepository: FakeAuthRepository;
  let sessionService: FakeSessionService;
  let resetRepository: FakePasswordResetRepository;
  let emailService: FakeEmailService;
  let passwordService: PasswordService;

  beforeEach(() => {
    authRepository = new FakeAuthRepository();
    sessionService = new FakeSessionService(authRepository);
    resetRepository = new FakePasswordResetRepository();
    emailService = new FakeEmailService();
    passwordService = new PasswordService();
  });

  async function boot() {
    return buildApp(undefined, {
      authRepository,
      sessionService,
      passwordService,
      passwordResetRepository: resetRepository,
      emailService,
    });
  }

  it('POST /auth/password-reset/request returns 202 for unknown emails without sending mail', async () => {
    const app = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { email: 'ghost@rene.wrld' },
    });
    expect(res.statusCode).toBe(202);
    expect(emailService.sent).toHaveLength(0);
    await app.close();
  });

  it('full flow: register -> login -> request -> confirm -> old session dead, new password works', async () => {
    const app = await boot();

    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'flow@rene.wrld', password: 'original-pass-1' },
    });
    expect(reg.statusCode).toBe(201);
    const regCookie = reg.headers['set-cookie'] as string;

    const reqRes = await app.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { email: 'flow@rene.wrld' },
    });
    expect(reqRes.statusCode).toBe(202);
    expect(emailService.sent).toHaveLength(1);
    const rawToken = emailService.sent[0].rawToken;

    const confirm = await app.inject({
      method: 'POST',
      url: '/auth/password-reset/confirm',
      payload: { token: rawToken, newPassword: 'rotated-pass-99' },
    });
    expect(confirm.statusCode).toBe(200);

    // Pre-reset session is revoked.
    const meOld = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: regCookie },
    });
    expect(meOld.statusCode).toBe(401);

    // Old password no longer works; new password does.
    const loginOld = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'flow@rene.wrld', password: 'original-pass-1' },
    });
    expect(loginOld.statusCode).toBe(401);

    const loginNew = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'flow@rene.wrld', password: 'rotated-pass-99' },
    });
    expect(loginNew.statusCode).toBe(200);
    await app.close();
  });

  it('POST /auth/password-reset/confirm rejects a reused token with 400', async () => {
    const app = await boot();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'reuse@rene.wrld', password: 'original-pass-1' },
    });
    await app.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { email: 'reuse@rene.wrld' },
    });
    const rawToken = emailService.sent[0].rawToken;
    const first = await app.inject({
      method: 'POST',
      url: '/auth/password-reset/confirm',
      payload: { token: rawToken, newPassword: 'rotated-pass-99' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/auth/password-reset/confirm',
      payload: { token: rawToken, newPassword: 'another-pass-11' },
    });
    expect(second.statusCode).toBe(400);
    await app.close();
  });

  it('request validates email shape (400 on garbage)', async () => {
    const app = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password-reset/request',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
