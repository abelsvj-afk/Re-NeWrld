import Fastify, { FastifyInstance, RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression } from 'fastify';
import multipart from '@fastify/multipart';
import pino from 'pino';
import crypto from 'crypto';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { logger } from './shared/logger/pino.logger.js';
import { AuthRepositoryPort } from './modules/auth/domain/ports/auth.repository.port.js';
import { WorldRepositoryPort } from './modules/world/domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from './modules/world/domain/ports/scene.repository.port.js';
import { CharacterRepositoryPort } from './modules/world/domain/ports/character.repository.port.js';
import { ChapterRepositoryPort } from './modules/world/domain/ports/chapter.repository.port.js';
import { ChoiceRepositoryPort } from './modules/world/domain/ports/choice.repository.port.js';
import { CanonRepositoryPort } from './modules/world/domain/ports/canon.repository.port.js';
import { SessionServicePort } from './modules/auth/domain/ports/session.port.js';
import { PostgresAuthRepository } from './modules/auth/infrastructure/persistence/postgres-auth.repository.js';
import { PostgresWorldRepository } from './modules/world/infrastructure/persistence/postgres-world.repository.js';
import { PostgresSceneRepository } from './modules/world/infrastructure/persistence/postgres-scene.repository.js';
import { PostgresCharacterRepository } from './modules/world/infrastructure/persistence/postgres-character.repository.js';
import { PostgresChapterRepository } from './modules/world/infrastructure/persistence/postgres-chapter.repository.js';
import { PostgresNarrationRepository } from './modules/world/infrastructure/persistence/postgres-narration.repository.js';
import { ElevenLabsClient } from './modules/world/infrastructure/elevenlabs.client.js';
import { NarrationRepositoryPort } from './modules/world/domain/ports/narration.repository.port.js';
import { PostgresChoiceRepository } from './modules/world/infrastructure/persistence/postgres-choice.repository.js';
import { PostgresCanonRepository } from './modules/world/infrastructure/persistence/postgres-canon.repository.js';
import { SessionRepositoryPort } from './modules/session/domain/ports/session.repository.port.js';
import { IdempotencyRepositoryPort } from './modules/session/domain/ports/idempotency.repository.port.js';
import { PostgresSessionRepository } from './modules/session/infrastructure/persistence/postgres-session.repository.js';
import { PostgresIdempotencyRepository } from './modules/session/infrastructure/persistence/postgres-idempotency.repository.js';
import { PostgresPasswordResetRepository } from './modules/auth/infrastructure/persistence/postgres-password-reset.repository.js';
import { ResendEmailAdapter } from './modules/auth/infrastructure/email/resend-email.adapter.js';
import { ConsoleEmailAdapter } from './modules/auth/infrastructure/email/console-email.adapter.js';
import { PasswordResetRepositoryPort } from './modules/auth/domain/ports/password-reset.repository.port.js';
import { EmailServicePort } from './modules/auth/application/ports/email-service.port.js';
import { SessionService } from './modules/auth/infrastructure/services/session.service.js';
import { PasswordService } from './modules/auth/infrastructure/services/password.service.js';
import { authRoutes } from './modules/auth/http/auth.routes.js';
import { worldRoutes } from './modules/world/http/world.routes.js';
import { sessionRoutes } from './modules/session/http/session.routes.js';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';

// Bounded validation regex for incoming x-request-id (alphanumeric, hyphens, underscores, periods, colons; 1-128 chars)
const REQUEST_ID_REGEX = /^[a-zA-Z0-9_\-\.:]{1,128}$/;

export interface AppDeps {
  authRepository?: AuthRepositoryPort;
  worldRepository?: WorldRepositoryPort;
  sceneRepository?: SceneRepositoryPort;
  characterRepository?: CharacterRepositoryPort;
  chapterRepository?: ChapterRepositoryPort;
  narrationRepository?: NarrationRepositoryPort;
  choiceRepository?: ChoiceRepositoryPort;
  canonRepository?: CanonRepositoryPort;
  sessionRepository?: SessionRepositoryPort;
  idempotencyRepository?: IdempotencyRepositoryPort;
  sessionService?: SessionServicePort;
  passwordService?: PasswordService;
  passwordResetRepository?: PasswordResetRepositoryPort;
  emailService?: EmailServicePort;
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
    const body: Record<string, unknown> = {
      error: message,
      statusCode,
    };
    // Typed 4xx errors may carry a structured report (e.g. PublishingValidationError's
    // { blockers, warnings }); surface it so clients can act on it. Never attached
    // to 5xx responses — internal details stay server-side.
    if (statusCode >= 400 && statusCode < 500) {
      const report = (error as { report?: unknown }).report;
      if (report !== undefined) {
        body.report = report;
      }
    }
    reply.status(statusCode).send(body);
  });

  // Rate limiting: brute-force protection (threat model: "Brute Force & Credential
  // Abuse" — Planned). Skipped in test env so unit tests never flake on limits.
  if (env.APP_ENV !== 'test') {
    await app.register(rateLimit, {
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW_MS,
    });
  }

  // Multipart for media uploads (cover art, scene illustrations)
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10MB max
  });

  // CORS: only when a browser frontend origin is configured (Phase H).
  // Unset CORS_ORIGIN = no CORS headers (API-only mode).
  if (env.CORS_ORIGIN) {
    await app.register(cors, {
      origin: env.CORS_ORIGIN,
      credentials: true,
    });
  }

  // Resolve dependencies (real infrastructure by default; fakes injectable for tests)
  const authRepository = deps?.authRepository ?? new PostgresAuthRepository();
  const worldRepository = deps?.worldRepository ?? new PostgresWorldRepository();
  const sceneRepository = deps?.sceneRepository ?? new PostgresSceneRepository();
  const characterRepository = deps?.characterRepository ?? new PostgresCharacterRepository();
  const chapterRepository = deps?.chapterRepository ?? new PostgresChapterRepository();
  const narrationRepository = deps?.narrationRepository ?? new PostgresNarrationRepository();
  const elevenLabs = env.ELEVENLABS_API_KEY
    ? new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY })
    : null;
  const choiceRepository = deps?.choiceRepository ?? new PostgresChoiceRepository();
  const canonRepository = deps?.canonRepository ?? new PostgresCanonRepository();
  const sessionRepository = deps?.sessionRepository ?? new PostgresSessionRepository();
  const idempotencyRepository = deps?.idempotencyRepository ?? new PostgresIdempotencyRepository();
  const sessionService = deps?.sessionService ?? new SessionService();
  const passwordService = deps?.passwordService ?? new PasswordService();
  const passwordResetRepository =
    deps?.passwordResetRepository ?? new PostgresPasswordResetRepository();
  const emailService =
    deps?.emailService ??
    (env.EMAIL_PROVIDER === 'resend'
      ? new ResendEmailAdapter({
          apiKey: env.RESEND_API_KEY as string,
          from: env.EMAIL_FROM,
          baseUrl: env.APP_BASE_URL,
        })
      : new ConsoleEmailAdapter(env.APP_BASE_URL));

  await app.register(async (instance) => {
    await authRoutes(instance, {
      authRepository,
      sessionService,
      passwordService,
      passwordResetRepository,
      emailService,
    });
    await worldRoutes(instance, {
      worldRepository,
      sceneRepository,
      chapterRepository,
      narrationRepository,
      elevenLabs,
      narrationStoragePath: env.NARRATION_STORAGE_PATH,
      mediaStoragePath: env.MEDIA_STORAGE_PATH,
      narrationMonthlyCharCap: env.NARRATION_MONTHLY_CHAR_CAP,
      choiceRepository,
      characterRepository,
      canonRepository,
      sessionVerifier: sessionService.getVerifier(),
    });
    await sessionRoutes(instance, {
      sessionRepository,
      worldRepository,
      canonRepository,
      idempotencyRepository,
      sessionVerifier: sessionService.getVerifier(),
    });
  });

  // Health check endpoint
  app.get('/health', async (request, reply) => {
    request.log.info('Health check accessed');
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Serve the React SPA (Phase H). API routes take precedence; unmatched
  // GETs fall through to index.html for client-side routing.
  const path = await import('node:path');
  const fs = await import('node:fs');
  const webDist = path.join(process.cwd(), 'src/web/dist');
  // Serve uploaded media (cover art, scene illustrations)
  const fastifyStatic = (await import('@fastify/static')).default;
  await fs.promises.mkdir(env.MEDIA_STORAGE_PATH, { recursive: true }).catch(() => {});
  await app.register(fastifyStatic, { root: env.MEDIA_STORAGE_PATH, prefix: '/media/' });
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.method === 'GET' && !req.raw.url?.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
