import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireReader } from '../../../shared/middleware/auth.middleware.js';
import type { SessionVerifier } from '../../../shared/middleware/auth.middleware.js';
import { WorldId } from '../../world/domain/value-objects/world-id.value-object.js';
import { CanonRepositoryPort } from '../../world/domain/ports/canon.repository.port.js';
import { WorldRepositoryPort } from '../../world/domain/ports/world.repository.port.js';
import { StartReaderSessionUseCase } from '../application/start-reader-session.use-case.js';
import { GetReaderSessionUseCase } from '../application/get-reader-session.use-case.js';
import { SessionRepositoryPort } from '../domain/ports/session.repository.port.js';
import { ReaderSession } from '../domain/entities/reader-session.entity.js';
import { SessionId } from '../domain/value-objects/session-id.value-object.js';

export interface SessionRouteDeps {
  sessionRepository: SessionRepositoryPort;
  worldRepository: WorldRepositoryPort;
  canonRepository: CanonRepositoryPort;
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
}
