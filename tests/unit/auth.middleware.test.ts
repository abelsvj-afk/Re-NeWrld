import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { authenticate, requireCreator, requireReader, requireRole } from '../../src/shared/middleware/auth.middleware.js';
import { SessionVerifier, SessionInfo, SessionService } from '../../src/modules/auth/infrastructure/services/session.service.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';

describe('Auth & RBAC Middleware Unit Tests', () => {
  const mockUserId = new UserId('11111111-1111-4111-8111-111111111111');
  const mockEmail = new Email('test@rene.wrld');

  const creatorSession: SessionInfo = {
    userId: mockUserId,
    email: mockEmail,
    role: new UserRole('creator'),
    expiresAt: new Date(Date.now() + 3600000),
  };

  const readerSession: SessionInfo = {
    userId: mockUserId,
    email: mockEmail,
    role: new UserRole('reader'),
    expiresAt: new Date(Date.now() + 3600000),
  };

  const mockVerifier: SessionVerifier = async (token: string) => {
    if (token === 'valid_creator_token_1234567890abcdef') return creatorSession;
    if (token === 'valid_reader_token_1234567890abcdef') return readerSession;
    if (token === 'error_token') throw new Error('Database connection failed: confidential_db_password_secret_999');
    return null;
  };

  it('should authenticate successfully with a valid session cookie', async () => {
    const app = Fastify();
    app.get('/test', { preHandler: [authenticate(mockVerifier)] }, async (req) => {
      return { userId: req.user?.userId.getValue(), role: req.user?.role.getValue() };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        cookie: 'rene_session_id=valid_creator_token_1234567890abcdef',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: mockUserId.getValue(),
      role: 'creator',
    });
  });

  it('should return 401 if session cookie is missing and not execute route handler', async () => {
    const app = Fastify();
    let handlerExecuted = false;
    app.get('/test', { preHandler: [authenticate(mockVerifier)] }, async () => {
      handlerExecuted = true;
      return { success: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty('error');
    expect(handlerExecuted).toBe(false);
  });

  it('should return 401 if session token is invalid or expired', async () => {
    const app = Fastify();
    let handlerExecuted = false;
    app.get('/test', { preHandler: [authenticate(mockVerifier)] }, async () => {
      handlerExecuted = true;
      return { success: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        cookie: 'rene_session_id=invalid_token_999999999999999999',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty('error');
    expect(handlerExecuted).toBe(false);
  });

  it('should not mask verifier errors as 401 and should not leak internal database error details in client response', async () => {
    const app = Fastify();
    // Add same error handler as app.ts
    app.setErrorHandler((error, request, reply) => {
      const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
      const message = statusCode === 500 ? 'Internal Server Error' : error.message;
      reply.status(statusCode).send({ error: message, statusCode });
    });

    app.get('/test', { preHandler: [authenticate(mockVerifier)] }, async () => {
      return { success: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        cookie: 'rene_session_id=error_token',
      },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('Internal Server Error');
    expect(JSON.stringify(body)).not.toContain('confidential_db_password_secret_999');
  });

  it('should allow creator through requireCreator guard', async () => {
    const app = Fastify();
    app.get('/creator', { preHandler: [authenticate(mockVerifier), requireCreator()] }, async () => {
      return { allowed: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/creator',
      headers: {
        cookie: 'rene_session_id=valid_creator_token_1234567890abcdef',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowed: true });
  });

  it('should deny reader with 403 on requireCreator guard', async () => {
    const app = Fastify();
    app.get('/creator', { preHandler: [authenticate(mockVerifier), requireCreator()] }, async () => {
      return { allowed: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/creator',
      headers: {
        cookie: 'rene_session_id=valid_reader_token_1234567890abcdef',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toHaveProperty('error');
  });

  it('should allow reader through requireReader guard', async () => {
    const app = Fastify();
    app.get('/reader', { preHandler: [authenticate(mockVerifier), requireReader()] }, async () => {
      return { allowed: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/reader',
      headers: {
        cookie: 'rene_session_id=valid_reader_token_1234567890abcdef',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowed: true });
  });

  it('should deny creator with 403 on requireReader guard', async () => {
    const app = Fastify();
    app.get('/reader', { preHandler: [authenticate(mockVerifier), requireReader()] }, async () => {
      return { allowed: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/reader',
      headers: {
        cookie: 'rene_session_id=valid_creator_token_1234567890abcdef',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toHaveProperty('error');
  });

  it('should return 401 if request.user is missing when guard runs', async () => {
    const app = Fastify();
    app.get('/guard-only', { preHandler: [requireCreator()] }, async () => {
      return { allowed: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/guard-only',
    });

    expect(res.statusCode).toBe(401);
  });
});
