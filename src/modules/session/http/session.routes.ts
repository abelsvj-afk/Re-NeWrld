import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireReader } from '../../../shared/middleware/auth.middleware.js';
import type { SessionVerifier } from '../../../shared/middleware/auth.middleware.js';
import { WorldId } from '../../world/domain/value-objects/world-id.value-object.js';
import { ChoiceId } from '../../world/domain/value-objects/choice-id.value-object.js';
import { CanonRepositoryPort } from '../../world/domain/ports/canon.repository.port.js';
import { WorldRepositoryPort } from '../../world/domain/ports/world.repository.port.js';
import { StartReaderSessionUseCase } from '../application/start-reader-session.use-case.js';
import { GetReaderSessionUseCase } from '../application/get-reader-session.use-case.js';
import { SubmitChoiceUseCase } from '../application/submit-choice.use-case.js';
import { SessionRepositoryPort } from '../domain/ports/session.repository.port.js';
import { IdempotencyRepositoryPort } from '../domain/ports/idempotency.repository.port.js';
import { ReaderSession } from '../domain/entities/reader-session.entity.js';
import { SessionId } from '../domain/value-objects/session-id.value-object.js';

export interface SessionRouteDeps {
  sessionRepository: SessionRepositoryPort;
  worldRepository: WorldRepositoryPort;
  canonRepository: CanonRepositoryPort;
  idempotencyRepository: IdempotencyRepositoryPort;
  sessionVerifier: SessionVerifier;
}

const WorldParams = z.object({
  id: z.string().uuid({ message: 'Invalid world id' }),
});

const SessionParams = z.object({
  id: z.string().uuid({ message: 'Invalid session id' }),
});

function parseWorldId(id: string): WorldId {
  try {
    return new WorldId(id);
  } catch {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['id'],
        message: 'Invalid world id',
      },
    ]);
  }
}

function parseSessionId(id: string): SessionId {
  try {
    return new SessionId(id);
  } catch {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['id'],
        message: 'Invalid session id',
      },
    ]);
  }
}

function parseChoiceId(id: string): ChoiceId {
  try {
    return new ChoiceId(id);
  } catch {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['choiceId'],
        message: 'Invalid choice id',
      },
    ]);
  }
}

/** D2 request body — strict. */
const SubmitChoiceBody = z
  .object({
    choiceId: z.string().uuid({ message: 'Invalid choice id' }),
    expectedVersion: z.number().int().positive({ message: 'expectedVersion must be a positive integer' }),
  })
  .strict();

const IdempotencyKeyHeader = z
  .string()
  .uuid({ message: 'Invalid X-Idempotency-Key' })
  .refine(
    (v) => {
      // ADR-015 D2: the key must be a UUIDv4 specifically (not just any UUID
      // version). v4 = 3rd group starts with '4', 4th group starts with 8/9/a/b.
      const parts = v.split('-');
      return (
        parts.length === 5 &&
        parts[2][0] === '4' &&
        ['8', '9', 'a', 'b'].includes(parts[3][0].toLowerCase())
      );
    },
    { message: 'X-Idempotency-Key must be a UUIDv4' }
  );

function parseIdempotencyKey(request: { headers: Record<string, unknown> }): string {
  const raw = request.headers['x-idempotency-key'];
  if (typeof raw !== 'string' || raw.length === 0) {
    // Required header (ADR-013 D3; first enforced route) — missing → 400.
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['X-Idempotency-Key'],
        message: 'Missing required X-Idempotency-Key header',
      },
    ]);
  }
  return IdempotencyKeyHeader.parse(raw);
}

/** Public session shape — exactly the response fields, never the canon data. */
function toSessionJson(session: ReaderSession): Record<string, unknown> {
  return {
    sessionId: session.getSessionId().getValue(),
    readerId: session.getReaderId().getValue(),
    worldId: session.getWorldId().getValue(),
    snapshotId: session.getSnapshotId().getValue(),
    currentSceneId: session.getCurrentSceneId().getValue(),
    stateVariables: session.getStateVariables(),
    version: session.getVersion(),
    status: session.getStatus().getValue(),
    createdAt: session.getCreatedAt().toISOString(),
    updatedAt: session.getUpdatedAt().toISOString(),
  };
}

/**
 * Session HTTP routes (Task F1c). Unprefixed, following the E2b convention.
 *
 * - `POST /worlds/:id/sessions` — start a playthrough; reader role required.
 * - `GET /sessions/:id` — owner-only read; missing and cross-reader sessions
 *   both produce 404 (no existence oracle).
 * - `POST /sessions/:id/choices` (G2d, ADR-015 D2) — submit a choice;
 *   requires `X-Idempotency-Key: UUIDv4` (missing/malformed → 400).
 *
 * Reader identity comes exclusively from `request.user.userId` (set by
 * `authenticate`) — never from request input.
 */
export async function sessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): Promise<void> {
  const startSession = new StartReaderSessionUseCase(
    deps.worldRepository,
    deps.canonRepository,
    deps.sessionRepository
  );
  const getSession = new GetReaderSessionUseCase(deps.sessionRepository);
  const submitChoice = new SubmitChoiceUseCase(
    deps.sessionRepository,
    deps.canonRepository,
    deps.idempotencyRepository
  );

  app.post(
    '/worlds/:id/sessions',
    { preHandler: [authenticate(deps.sessionVerifier), requireReader()] },
    async (request, reply) => {
      const params = WorldParams.parse(request.params);
      const { session, snapshot } = await startSession.execute({
        worldId: parseWorldId(params.id),
        readerId: request.user!.userId,
      });
      return reply.code(201).send({
        sessionId: session.getSessionId().getValue(),
        snapshotId: session.getSnapshotId().getValue(),
        versionNumber: snapshot.getVersionNumber(),
        currentSceneId: session.getCurrentSceneId().getValue(),
        status: session.getStatus().getValue(),
      });
    }
  );

  app.get('/sessions/:id', { preHandler: [authenticate(deps.sessionVerifier)] }, async (request) => {
    const params = SessionParams.parse(request.params);
    const { session } = await getSession.execute({
      sessionId: parseSessionId(params.id),
      readerId: request.user!.userId,
    });
    return toSessionJson(session);
  });

  app.post(
    '/sessions/:id/choices',
    { preHandler: [authenticate(deps.sessionVerifier), requireReader()] },
    async (request, reply) => {
      const params = SessionParams.parse(request.params);
      const body = SubmitChoiceBody.parse(request.body);
      const idempotencyKey = parseIdempotencyKey(request);
      const result = await submitChoice.execute({
        sessionId: parseSessionId(params.id),
        readerId: request.user!.userId,
        choiceId: parseChoiceId(body.choiceId),
        expectedVersion: body.expectedVersion,
        idempotencyKey,
      });
      return reply.code(200).send(result);
    }
  );
}
