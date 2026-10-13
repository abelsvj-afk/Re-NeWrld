import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { PasswordService } from '../../src/modules/auth/infrastructure/services/password.service.js';
import { FakeAuthRepository, FakeSessionService, FakeWorldRepository } from './helpers/test-fakes.js';

function extractSessionCookie(setCookie: string | string[] | undefined): string | null {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) return null;
  const match = header.match(/rene_session_id=([^;]*)/);
  return match ? `rene_session_id=${match[1]}` : null;
}

describe('Auth HTTP routes', () => {
  let authRepository: FakeAuthRepository;
  let sessionService: FakeSessionService;
  let passwordService: PasswordService;

  beforeEach(() => {
    authRepository = new FakeAuthRepository();
    sessionService = new FakeSessionService(authRepository);
    passwordService = new PasswordService();
  });

  async function boot() {
    return buildApp(undefined, { authRepository, sessionService, passwordService });
  }

  it('POST /auth/register creates a reader account and returns 201', async () => {
    const app = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'new@rene.wrld', password: 's3cure-password' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe('new@rene.wrld');
    expect(body.role).toBe('reader');
    expect(body.id).toBeDefined();
    expect(body.passwordHash).toBeUndefined();
    await app.close();
  });

  it('POST /auth/register rejects duplicate emails with 409', async () => {
    const app = await boot();
    const payload = { email: 'dupe@rene.wrld', password: 's3cure-password' };
    expect((await app.inject({ method: 'POST', url: '/auth/register', payload })).statusCode).toBe(201);
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('POST /auth/register rejects invalid email and short password with 400', async () => {
    const app = await boot();
    const badEmail = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 's3cure-password' },
    });
    expect(badEmail.statusCode).toBe(400);
    const shortPw = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'ok@rene.wrld', password: 'short' },
    });
    expect(shortPw.statusCode).toBe(400);
    await app.close();
  });

  it('POST /auth/login sets a session cookie and GET /auth/me returns the session', async () => {
    const app = await boot();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'login@rene.wrld', password: 's3cure-password' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login@rene.wrld', password: 's3cure-password' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = extractSessionCookie(login.headers['set-cookie']);
    expect(cookie).not.toBeNull();
    expect(login.headers['set-cookie']).toContain('HttpOnly');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie! } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('login@rene.wrld');
    await app.close();
  });

  it('POST /auth/login returns generic 401 for unknown email and wrong password', async () => {
    const app = await boot();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'victim@rene.wrld', password: 's3cure-password' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@rene.wrld', password: 's3cure-password' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'victim@rene.wrld', password: 'wrong-password' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    // No user enumeration: identical messages
    expect(unknown.json().error).toBe(wrong.json().error);
    await app.close();
  });

  it('GET /auth/me without a session returns 401', async () => {
    const app = await boot();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST /auth/become-creator upgrades a reader to creator (and unlocks world creation)', async () => {
    const worldRepository = new FakeWorldRepository();
    const app = await buildApp(undefined, { authRepository, sessionService, passwordService, worldRepository });

    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'future@rene.wrld', password: 's3cure-password' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'future@rene.wrld', password: 's3cure-password' },
    });
    const cookie = extractSessionCookie(login.headers['set-cookie']);
    expect(cookie).not.toBeNull();

    // Reader cannot create worlds yet
    const before = await app.inject({
      method: 'POST',
      url: '/worlds',
      headers: { cookie: cookie! },
      payload: { title: 'Too soon' },
    });
    expect(before.statusCode).toBe(403);

    // Upgrade
    const upgrade = await app.inject({
      method: 'POST',
      url: '/auth/become-creator',
      headers: { cookie: cookie! },
    });
    expect(upgrade.statusCode).toBe(200);
    expect(upgrade.json().role).toBe('creator');

    // Idempotent: second call still 200
    const again = await app.inject({
      method: 'POST',
      url: '/auth/become-creator',
      headers: { cookie: cookie! },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().role).toBe('creator');

    // Same session can now create worlds — no re-login needed
    const after = await app.inject({
      method: 'POST',
      url: '/worlds',
      headers: { cookie: cookie! },
      payload: { title: 'Now I can' },
    });
    expect(after.statusCode).toBe(201);
    await app.close();
  });

  it('POST /auth/become-creator without a session returns 401', async () => {
    const app = await boot();
    const res = await app.inject({ method: 'POST', url: '/auth/become-creator' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST /auth/logout revokes the session and clears the cookie', async () => {
    const app = await boot();
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'bye@rene.wrld', password: 's3cure-password' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'bye@rene.wrld', password: 's3cure-password' },
    });
    const cookie = extractSessionCookie(login.headers['set-cookie']);
    expect(cookie).not.toBeNull();

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: cookie! },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie! } });
    expect(me.statusCode).toBe(401);
    await app.close();
  });
});
