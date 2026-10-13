import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { AuthRepositoryPort } from '../domain/ports/auth.repository.port.js';
import {
  SessionServicePort,
  SESSION_COOKIE_NAME,
  cookieSecureForEnv,
} from '../domain/ports/session.port.js';
import { PasswordService } from '../infrastructure/services/password.service.js';
import { RegisterUserUseCase } from '../application/register-user.use-case.js';
import { LoginUserUseCase } from '../application/login-user.use-case.js';
import { BecomeCreatorUseCase } from '../application/become-creator.use-case.js';
import { RequestPasswordResetUseCase } from '../application/request-password-reset.use-case.js';
import { ConfirmPasswordResetUseCase } from '../application/confirm-password-reset.use-case.js';
import { PasswordResetRepositoryPort } from '../domain/ports/password-reset.repository.port.js';
import { EmailServicePort } from '../application/ports/email-service.port.js';
import { UserId } from '../domain/value-objects/user-id.value-object.js';
import { authenticate, getRequestToken } from '../../../shared/middleware/auth.middleware.js';

export interface AuthRouteDeps {
  authRepository: AuthRepositoryPort;
  sessionService: SessionServicePort;
  passwordService: PasswordService;
  passwordResetRepository: PasswordResetRepositoryPort;
  emailService: EmailServicePort;
}

const RegisterBody = z.object({
  email: z.string().email({ message: 'Invalid email address' }),
  password: z
    .string()
    .min(8, { message: 'Password must be at least 8 characters' })
    .max(128, { message: 'Password must not exceed 128 characters' }),
});

const LoginBody = z.object({
  email: z.string().email({ message: 'Invalid email address' }),
  password: z.string().min(1, { message: 'Password is required' }).max(128),
});

const PasswordResetRequestBody = z.object({
  email: z.string().email({ message: 'Invalid email address' }),
});

const PasswordResetConfirmBody = z.object({
  token: z.string().min(1, { message: 'Reset token is required' }).max(128),
  newPassword: z
    .string()
    .min(8, { message: 'Password must be at least 8 characters' })
    .max(128, { message: 'Password must not exceed 128 characters' }),
});

interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  path: string;
  maxAge?: number;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  const sameSite = options.sameSite || 'lax';
  parts.push(`SameSite=${sameSite.charAt(0).toUpperCase() + sameSite.slice(1)}`);
  return parts.join('; ');
}

export async function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const registerUseCase = new RegisterUserUseCase(deps.authRepository, deps.passwordService);
  const loginUseCase = new LoginUserUseCase(deps.authRepository, deps.sessionService, deps.passwordService);
  const becomeCreatorUseCase = new BecomeCreatorUseCase(deps.authRepository);
  const requestResetUseCase = new RequestPasswordResetUseCase(
    deps.authRepository,
    deps.passwordResetRepository,
    deps.emailService,
    deps.passwordService
  );
  const confirmResetUseCase = new ConfirmPasswordResetUseCase(
    deps.authRepository,
    deps.passwordResetRepository,
    deps.sessionService,
    deps.passwordService
  );
  const verifier = deps.sessionService.getVerifier();
  const secureCookies = cookieSecureForEnv(env.APP_ENV);

  // Tighter rate limit: registration and login are brute-force targets.
  const authRateLimit = {
    config: {
      rateLimit: {
        max: env.RATE_LIMIT_AUTH_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_MS,
      },
    },
  };

  // Strictest rate limit: the reset endpoints are account-takeover and spam
  // targets (ADR-012). 5 requests/hour per IP by default.
  const resetRateLimit = {
    config: {
      rateLimit: {
        max: env.RATE_LIMIT_RESET_MAX,
        timeWindow: env.RATE_LIMIT_RESET_WINDOW_MS,
      },
    },
  };

  app.post('/auth/register', authRateLimit, async (request, reply) => {
    const body = RegisterBody.parse(request.body);
    const user = await registerUseCase.execute(body);
    // Auto-login: a fresh registration immediately establishes a session, so
    // the new user doesn't have to turn around and call /auth/login.
    const { sessionId, expiresAt } = await deps.sessionService.createSession(new UserId(user.id));
    const regCookieOptions = deps.sessionService.getCookieOptions(secureCookies, expiresAt);
    reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, sessionId, regCookieOptions));
    return reply.code(201).send({
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.post('/auth/login', authRateLimit, async (request, reply) => {
    const body = LoginBody.parse(request.body);
    const result = await loginUseCase.execute(body);
    const cookieOptions = deps.sessionService.getCookieOptions(secureCookies, result.expiresAt);
    reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, result.token, cookieOptions));
    return reply.send({
      id: result.user.id,
      email: result.user.email,
      role: result.user.role,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  app.post('/auth/logout', { preHandler: authenticate(verifier) }, async (request, reply) => {
    const token = getRequestToken(request);
    if (token) {
      await deps.sessionService.revokeSession(token);
    }
    const clearOptions = deps.sessionService.getCookieOptions(secureCookies);
    reply.header(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE_NAME, '', { ...clearOptions, maxAge: 0 })
    );
    return reply.send({ ok: true });
  });

  // Self-serve upgrade: any authenticated reader can become a creator.
  // Idempotent; takes effect immediately (role is resolved per-request).
  app.post('/auth/become-creator', { preHandler: authenticate(verifier) }, async (request) => {
    const session = request.user;
    if (!session) {
      // Unreachable: authenticate() 401s before this handler runs. Defensive.
      throw new Error('Session missing after authentication');
    }
    return becomeCreatorUseCase.execute(session.userId);
  });

  app.get('/auth/me', { preHandler: authenticate(verifier) }, async (request) => {
    const session = request.user;
    if (!session) {
      // Unreachable: authenticate() 401s before this handler runs. Defensive.
      throw new Error('Session missing after authentication');
    }
    return {
      id: session.userId.getValue(),
      email: session.email.getValue(),
      role: session.role.getValue(),
      expiresAt: session.expiresAt.toISOString(),
    };
  });

  // Password reset (FR-13, ADR-012). The request endpoint always returns 202 —
  // it never reveals whether the email is registered (anti-enumeration).
  app.post('/auth/password-reset/request', resetRateLimit, async (request, reply) => {
    const body = PasswordResetRequestBody.parse(request.body);
    await requestResetUseCase.execute(body);
    return reply.code(202).send({ ok: true });
  });

  app.post('/auth/password-reset/confirm', resetRateLimit, async (request, reply) => {
    const body = PasswordResetConfirmBody.parse(request.body);
    await confirmResetUseCase.execute({ token: body.token, newPassword: body.newPassword });
    return reply.send({ ok: true });
  });
}
