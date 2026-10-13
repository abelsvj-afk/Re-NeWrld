import Fastify, { FastifyInstance, RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression } from 'fastify';
import pino from 'pino';
import crypto from 'crypto';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { logger } from './shared/logger/pino.logger.js';
import { AuthRepositoryPort } from './modules/auth/domain/ports/auth.repository.port.js';
import { WorldRepositoryPort } from './modules/world/domain/ports/world.repository.port.js';
import { SessionServicePort } from './modules/auth/domain/ports/session.port.js';
import { PostgresAuthRepository } from './modules/auth/infrastructure/persistence/postgres-auth.repository.js';
import { PostgresWorldRepository } from './modules/world/infrastructure/persistence/postgres-world.repository.js';
import { SessionService } from './modules/auth/infrastructure/services/session.service.js';
import { PasswordService } from './modules/auth/infrastructure/services/password.service.js';
import { authRoutes } from './modules/auth/http/auth.routes.js';
import { worldRoutes } from './modules/world/http/world.routes.js';

// Bounded validation regex for incoming x-request-id (alphanumeric, hyphens, underscores, periods, colons; 1-128 chars)
const REQUEST_ID_REGEX = /^[a-zA-Z0-9_\-\.:]{1,128}$/;

export interface AppDeps {
  authRepository?: AuthRepositoryPort;
  worldRepository?: WorldRepositoryPort;
  sessionService?: SessionServicePort;
  passwordService?: PasswordService;
}

export async function buildApp(customLogger?: pino.Logger, deps?: AppDeps): Promise<FastifyInstance<RawServerDefault, RawRequestDefaultExpression<RawServerDefault>, RawReplyDefaultExpression<RawServerDefault>, pino.Logger>> {
  const activeLogger = customLogger || logger;
  const app = Fastify({
    logger: activeLogger,
    genReqId: (req) => {
      const incomingId = req.headers['x-request-id'];
      if (typeof incomingId === 'string' && REQUEST_ID_REGEX.test(incomingId)) {
        return incomingId;
      }
      return crypto.randomUUID();
    },
  });

  // Ensure correlation ID is included at request logging layer and response header
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    // Automatically bind correlationId to request logger so all request log events carry it
    request.log = request.log.child({ correlationId: request.id });
  });

  // Generic error handler: ZodError -> 400 with validation failed issues; typed errors -> statusCode; never return error.message for status >= 500
  app.setErrorHandler((error, request, reply) => {
    let statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;

    if (error instanceof ZodError || error.name === 'ZodError' || Array.isArray((error as any).issues)) {
      statusCode = 400;
      request.log.warn(error, 'Client error');
      const zodErr = error as unknown as ZodError;
      return reply.status(400).send({
        error: 'Validation failed',
        statusCode: 400,
        issues: zodErr.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn(error, 'Client error');
    } else {
      request.log.error(error, 'Unhandled application error');
    }

    const message = statusCode >= 500 ? 'Internal Server Error' : error.message;
    reply.status(statusCode).send({
      error: message,
      statusCode,
    });
  });

  // Resolve dependencies (real infrastructure by default; fakes injectable for tests)
  const authRepository = deps?.authRepository ?? new PostgresAuthRepository();
  const worldRepository = deps?.worldRepository ?? new PostgresWorldRepository();
  const sessionService = deps?.sessionService ?? new SessionService();
  const passwordService = deps?.passwordService ?? new PasswordService();

  await app.register(async (instance) => {
    await authRoutes(instance, { authRepository, sessionService, passwordService });
    await worldRoutes(instance, { worldRepository, sessionVerifier: sessionService.getVerifier() });
  });

  // Health check endpoint
  app.get('/health', async (request, reply) => {
    request.log.info('Health check accessed');
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return app;
}
