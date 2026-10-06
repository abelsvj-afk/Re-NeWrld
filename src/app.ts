import Fastify, { FastifyInstance, RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression } from 'fastify';
import pino from 'pino';
import crypto from 'crypto';
import { env } from './config/env.js';
import { logger } from './shared/logger/pino.logger.js';

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

  // Health check endpoint
  app.get('/health', async (request, reply) => {
    request.log.info('Health check accessed');
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return app;
}
