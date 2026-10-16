import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireReader } from '../../../shared/middleware/auth.middleware.js';
import type { SessionVerifier } from '../../../shared/middleware/auth.middleware.js';
import {
  WorldId,
  ChoiceId,
  CanonRepositoryPort,
  WorldRepositoryPort,
  ConditionSchema,
  getGrammarMarker,
  type GrammarMarkerInfo,
} from '../../world/application/index.js';
import { evaluateCondition, type SessionState as EvalState } from '../domain/services/condition-evaluator.js';
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
function isListable(raw: unknown, marker: GrammarMarkerInfo, state: EvalState): boolean {
  if (raw === undefined) return true;
  const parsed = ConditionSchema.safeParse(raw);
  if (!parsed.success) {
    return false;
  }
  return evaluateCondition(parsed.data, state);
}

/**
 * Format a human-readable lock reason from choice conditions.
 * Simple formatter for common patterns; falls back to generic message.
 */
function formatLockReason(conditions: unknown): string {
  if (!conditions || typeof conditions !== 'object') {
    return 'Requires special conditions';
  }
  // Try to extract meaningful info from condition structure
  // For now, generic message — enhanced when Variable Registry (B) provides labels
  return 'Requires unmet conditions';
}

/**
 * Format human-readable display text for an applied mutation (Item F).
 * Examples: "+10 Honor", "Acquired: Iron Key", "Kael will remember that"
 */
function formatMutationDisplay(m: { op: string; var: string; value?: unknown }): string {
  const label = m.var.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  switch (m.op) {
    case 'inc':
      return `+${m.value} ${label}`;
    case 'dec':
      return `-${m.value} ${label}`;
    case 'set':
      if (typeof m.value === 'boolean') {
        return m.value ? `Acquired: ${label}` : `Lost: ${label}`;
      }
      return `${label}: ${m.value}`;
    case 'toggle':
      return `${label} toggled`;
    case 'unset':
      return `Removed: ${label}`;
    default:
      return `${label} updated`;
  }
}

function toSessionJson(session: ReaderSession, canonData?: { scenes: Array<{ scene_id: string; title: string; prose: string; metadata: Record<string, unknown>; is_ending: boolean }>; choices: Array<{ choice_id: string; scene_id: string; target_scene_id: string; text: string; conditions?: unknown; visibility?: string }> }): Record<string, unknown> {
  const currentSceneId = session.getCurrentSceneId().getValue();
  const scene = canonData?.scenes.find((s) => s.scene_id === currentSceneId);
  const state = session.getStateVariables() as EvalState;
  const marker = getGrammarMarker(canonData);
  const sceneChoices = (canonData?.choices ?? [])
    .filter((c) => c.scene_id === currentSceneId)
    .map((c) => {
      const listable = isListable(c.conditions, marker, state);
      const showLocked = c.visibility === 'show_locked' && !listable;
      // Include if listable, or if show_locked policy and not listable
      if (!listable && !showLocked) return null;
      return {
        id: c.choice_id,
        text: c.text,
        targetSceneId: c.target_scene_id,
        locked: showLocked,
        lockReason: showLocked ? formatLockReason(c.conditions) : undefined,
      };
    })
    .filter((c) => c !== null);

  return {
    id: session.getSessionId().getValue(),
    worldId: session.getWorldId().getValue(),
    currentSceneId,
    sceneText: scene?.prose ?? '',
    sceneTitle: scene?.title ?? '',
    sceneMetadata: scene?.metadata ?? {},
    isEnding: scene?.is_ending ?? false,
    choices: sceneChoices,
    variables: session.getStateVariables(),
    version: session.getVersion(),
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
      const canonData = snapshot.getCanonData() as { scenes: Array<{ scene_id: string; title: string; prose: string; metadata: Record<string, unknown>; is_ending: boolean }>; choices: Array<{ choice_id: string; scene_id: string; target_scene_id: string; text: string; conditions?: unknown; visibility?: string }> };
      return reply.code(201).send(toSessionJson(session, canonData));
    }
  );

  app.get('/sessions/:id', { preHandler: [authenticate(deps.sessionVerifier)] }, async (request) => {
    const params = SessionParams.parse(request.params);
    const { session } = await getSession.execute({
      sessionId: parseSessionId(params.id),
      readerId: request.user!.userId,
    });
    const snapshot = await deps.canonRepository.findById(session.getSnapshotId());
    const canonData = snapshot?.getCanonData() as { scenes: Array<{ scene_id: string; title: string; prose: string; metadata: Record<string, unknown>; is_ending: boolean }>; choices: Array<{ choice_id: string; scene_id: string; target_scene_id: string; text: string; conditions?: unknown; visibility?: string }> } | undefined;
    return toSessionJson(session, canonData);
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
      // Return the full session state in the frontend-compatible format
      const { session } = await getSession.execute({
        sessionId: parseSessionId(params.id),
        readerId: request.user!.userId,
      });
      const snapshot = await deps.canonRepository.findById(session.getSnapshotId());
      const canonData = snapshot?.getCanonData() as { scenes: Array<{ scene_id: string; title: string; prose: string; metadata: Record<string, unknown>; is_ending: boolean }>; choices: Array<{ choice_id: string; scene_id: string; target_scene_id: string; text: string; conditions?: unknown; visibility?: string }> } | undefined;
      const sessionJson = toSessionJson(session, canonData);
      // Include applied mutations for consequence cue toasts (Item F)
      (sessionJson as Record<string, unknown>).mutationsApplied = result.appliedMutations.map((m) => {
        if ('removed' in m) {
          return { variable: m.var, operation: m.op, displayText: formatMutationDisplay({ op: m.op, var: m.var }) };
        }
        return { variable: m.var, operation: m.op, value: m.value, displayText: formatMutationDisplay({ op: m.op, var: m.var, value: m.value }) };
      });
      return reply.code(200).send(sessionJson);
    }
  );
}
