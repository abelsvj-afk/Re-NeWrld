import Fastify, { FastifyInstance, RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression } from 'fastify';
import pino from 'pino';
import crypto from 'crypto';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { logger } from './shared/logger/pino.logger.js';
import { WorldValidationError } from './modules/world/domain/errors/world.errors.js';

// Bounded validation regex for incoming x-request-id (alphanumeric, hyphens, underscores, periods, colons; 1-128 chars)
const REQUEST_ID_REGEX = /^[a-zA-Z0-9_\-\.:]{1,128}$/;

export async function buildApp(customLogger?: pino.Logger): Promise<FastifyInstance<RawServerDefault, RawRequestDefaultExpression<RawServerDefault>, RawReplyDefaultExpression<RawServerDefault>, pino.Logger>> {
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

  // Health check endpoint
  app.get('/health', async (request, reply) => {
    request.log.info('Health check accessed');
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return app;
}
