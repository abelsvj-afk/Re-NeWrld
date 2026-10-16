import { z } from 'zod';
import type pkg from 'pg';
import { withTransaction } from '../../../shared/database/db.js';
import { SessionRepositoryPort } from '../domain/ports/session.repository.port.js';
import {
  CanonRepositoryPort,
  SceneId,
  ChoiceId,
} from '../../world/application/index.js';
import {
  IdempotencyRepositoryPort,
  IdempotencyRecord,
} from '../domain/ports/idempotency.repository.port.js';
import { CheckpointRepositoryPort } from '../domain/ports/checkpoint.repository.port.js';
import { ReaderSession, SessionState } from '../domain/entities/reader-session.entity.js';
import { SessionStateSchema } from '../domain/entities/reader-session.entity.js';
import { SessionId } from '../domain/value-objects/session-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from '../domain/errors/session.errors.js';
import {
  CanonInvariantError,
  LegacyPayloadRejectedError,
  MutationApplicationError,
  StateInvariantError,
  StoredResponseCorruptError,
  ChoiceNotAttachedError,
  ChoiceNotAvailableError,
  SessionTerminalError,
  IdempotencyConflictError,
  ChoiceNotFoundError,
} from '../domain/errors/choice.errors.js';
import {
  ConditionSchema,
  MutationListSchema,
  JsonValueSchema,
  type Condition,
  type Mutation,
  getGrammarMarker,
  type GrammarMarkerInfo,
} from '../../world/application/index.js';
import {
  evaluateCondition,
  type SessionState as EvalState,
} from '../domain/services/condition-evaluator.js';
import {
  applyMutations,
  type AppliedMutation,
} from '../domain/services/mutation-applier.js';
import { computeRequestFingerprint } from '../domain/services/idempotency-fingerprint.js';

export interface SubmitChoiceCommand {
  sessionId: SessionId;
  /** Derived exclusively from the authenticated session at the route layer — never from client input. */
  readerId: UserId;
  choiceId: ChoiceId;
  expectedVersion: number;
  /** Validated UUIDv4 by the route layer (missing/malformed → 400 there). */
  idempotencyKey: string;
}

export interface AvailableChoice {
  choiceId: string;
  text: string;
  sortOrder: number;
}

export interface SubmitChoiceResult {
  sessionId: string;
  version: number;
  currentSceneId: string;
  status: 'active' | 'completed';
  appliedMutations: AppliedMutation[];
  availableChoices: AvailableChoice[];
}

/**
 * D2 response schema (ADR-015 §3). Used twice: to validate the constructed
 * response before persisting it (defense in depth), and to validate stored
 * JSONB on every replay path (B38 — a corrupt stored response is never
 * served; it fails with StoredResponseCorruptError → 500).
 */
export const SubmitChoiceResponseSchema = z
  .object({
    sessionId: z.string().uuid(),
    version: z.number().int().positive(),
    currentSceneId: z.string().uuid(),
    status: z.enum(['active', 'completed']),
    appliedMutations: z.array(
      z.union([
        z
          .object({
            op: z.enum(['set', 'inc', 'dec', 'toggle']),
            var: z.string(),
            value: JsonValueSchema,
          })
          .strict(),
        z.object({ op: z.literal('unset'), var: z.string(), removed: z.boolean() }).strict(),
      ])
    ),
    availableChoices: z.array(
      z
        .object({
          choiceId: z.string().uuid(),
          text: z.string(),
          sortOrder: z.number(),
        })
        .strict()
    ),
  })
  .strict();

function isEmptyObject(x: unknown): boolean {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === 0;
}

/**
 * D1a policy boundary for the SELECTED choice's conditions (step 12).
 * Returns true when the choice is available. Throws per the
 * marker-dependent policy — never returns false for a parse failure.
 */
function evaluateSelectedConditions(
  raw: unknown,
  marker: GrammarMarkerInfo,
  state: EvalState
): boolean {
  if (raw === undefined) return true; // unconditional
  if (isEmptyObject(raw) && !marker.hadMarker) return true; // legacy grandfathered
  const parsed = ConditionSchema.safeParse(raw);
  if (!parsed.success) {
    if (marker.hadMarker) {
      throw new CanonInvariantError('Marked canon contains an unparsable condition');
    }
    // Legacy fail-closed: the choice is unavailable, session stays functional.
    throw new ChoiceNotAvailableError('Choice condition cannot be evaluated');
  }
  return evaluateCondition(parsed.data, state);
}

/**
 * D1a policy boundary for the SELECTED choice's mutations (step 13, parse
 * phase). Returns parsed mutations (absent ≡ []). Applicability failures
 * are raised by `applyMutations`, not here.
 */
function parseSelectedMutations(raw: unknown, marker: GrammarMarkerInfo): Mutation[] {
  if (raw === undefined) return [];
  const parsed = MutationListSchema.safeParse(raw);
  if (!parsed.success) {
    if (marker.hadMarker) {
      throw new CanonInvariantError('Marked canon contains unparsable mutations');
    }
    throw new LegacyPayloadRejectedError('Legacy mutations cannot be parsed');
  }
  return parsed.data;
}

/**
 * D1a policy boundary for AVAILABLE-CHOICES listing (step 15, B16/B33).
 * Marked snapshot with any unparsable condition → 500 (fail loud, B33).
 * Legacy unparsable → excluded (fail closed); legacy `{}` → unconditional.
 */
function isListable(raw: unknown, marker: GrammarMarkerInfo, state: EvalState): boolean {
  if (raw === undefined) return true;
  if (isEmptyObject(raw) && !marker.hadMarker) return true;
  const parsed = ConditionSchema.safeParse(raw);
  if (!parsed.success) {
    if (marker.hadMarker) {
      throw new CanonInvariantError(
        'Marked canon contains an unparsable condition in the target scene'
      );
    }
    return false;
  }
  return evaluateCondition(parsed.data, state);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

/**
 * Internal signal: the transaction found a live idempotency record and must
 * roll back, then return the stored response. `withTransaction` rolls back
 * on any throw; the use case catches this outside and returns the response.
 * Never escapes the use case; never mapped to HTTP.
 */
class ReplaySignal extends Error {
  constructor(public readonly response: SubmitChoiceResult) {
    super('Idempotent replay');
    this.name = 'ReplaySignal';
  }
}

/**
 * Submits a choice for a reader session (Task G2c, ADR-015 D3).
 *
 * Executes the 17-step deterministic protocol: pre-transaction idempotency
 * lookup → in-transaction lock, idempotency recheck, authoritative version
 * check, placement check, condition evaluation, mutation application,
 * entity transition, response construction, atomic persistence — with the
 * D3a unique-violation recovery as backstop.
 *
 * Failure precedence is load-bearing: idempotency replay precedes lifecycle
 * checks (a retry after completion replays the stored success, never
 * 409-terminal); the authoritative version check precedes state-dependent
 * evaluation (a stale client receives 409, never a masked 422).
 */
export class SubmitChoiceUseCase {
  constructor(
    private readonly sessions: SessionRepositoryPort,
    private readonly canon: CanonRepositoryPort,
    private readonly idempotency: IdempotencyRepositoryPort,
    private readonly checkpoints?: CheckpointRepositoryPort
  ) {}

  public async execute(command: SubmitChoiceCommand): Promise<SubmitChoiceResult> {
    return this.executeOnce(command, false);
  }

  private async executeOnce(
    command: SubmitChoiceCommand,
    isRetry: boolean
  ): Promise<SubmitChoiceResult> {
    const sessionIdStr = command.sessionId.getValue();
    const choiceIdStr = command.choiceId.getValue();
    const readerIdStr = command.readerId.getValue();
    const fingerprint = computeRequestFingerprint(
      choiceIdStr,
      command.expectedVersion,
      sessionIdStr,
      readerIdStr
    );

    // --- Pre-transaction (no writes) ---

    // Step 1: ownership before anything else (404-not-403).
    const session = await this.sessions.findById(command.sessionId);
    if (session === null || !session.getReaderId().equals(command.readerId)) {
      throw new SessionNotFoundError();
    }

    // Step 3: early idempotency lookup (unexpired only; read-only).
    const early = await this.idempotency.findUnexpiredByKey(command.idempotencyKey);
    if (early !== null) {
      this.assertReplayable(early, fingerprint, sessionIdStr);
      return this.validatedReplay(early);
    }

    // Step 4: fast-path terminal check (authoritative check repeats in-tx).
    if (!session.getStatus().isActive()) {
      throw new SessionTerminalError();
    }

    // Step 5: pinned canon snapshot (immutable; corrupt → 500, never fallback).
    const snapshot = await this.canon.findById(session.getSnapshotId());
    if (snapshot === null) {
      // Impossible via FK; a missing pinned snapshot is a server invariant failure.
      throw new StateInvariantError('Pinned canon snapshot not found');
    }
    const canonData = snapshot.getCanonData();
    const marker = getGrammarMarker(canonData);

    // Step 6: choice existence in the pinned canon (placement is in-tx, step 11).
    const choice = canonData.choices.find((c) => c.choice_id === choiceIdStr);
    if (!choice) {
      throw new ChoiceNotFoundError();
    }

    // --- Transaction (single; F2a mechanism extended) ---
    try {
      const result = await withTransaction(async (tx: pkg.PoolClient) => {
        // Step 7: lock the session row (vanished concurrently → 404).
        const locked = await this.sessions.findByIdForUpdate(command.sessionId, tx);
        if (locked === null) {
          throw new SessionNotFoundError();
        }

        // Step 8: re-check the idempotency key (covers the winner-committed-
        // between-lookup-and-lock race).
        const rec = await this.idempotency.findByKeyForUpdate(command.idempotencyKey, tx);
        if (rec !== null && !rec.isExpired) {
          this.assertReplayable(rec, fingerprint, sessionIdStr);
          throw new ReplaySignal(this.validatedReplay(rec));
        }
        if (rec !== null && rec.isExpired) {
          // Reclaim inside this transaction; a ROLLBACK undoes it —
          // "zero committed writes" holds on every failure path.
          await this.idempotency.deleteByKey(command.idempotencyKey, tx);
        }

        // Step 9: authoritative active check (catches completion after step 4).
        if (!locked.getStatus().isActive()) {
          throw new SessionTerminalError();
        }

        // Step 10: authoritative version check (409 with currentVersion).
        if (locked.getVersion() !== command.expectedVersion) {
          throw new SessionVersionConflictError(locked.getVersion());
        }

        // Step 11: placement — choice attached to the LOCKED current scene.
        if (choice.scene_id !== locked.getCurrentSceneId().getValue()) {
          throw new ChoiceNotAttachedError();
        }

        const lockedState = locked.getStateVariables();

        // Step 12: evaluate conditions (marker-dependent parse policy).
        if (!evaluateSelectedConditions(choice.conditions, marker, lockedState)) {
          throw new ChoiceNotAvailableError();
        }

        // Step 13: apply mutations in memory (parse policy, then applicability).
        const mutations = parseSelectedMutations(choice.mutations, marker);
        const { state: newState, applied } = applyMutations(lockedState, mutations);

        // Step 14: one atomic domain transition (state replace + version +
        // scene + derived completion). Validates the computed state first —
        // a non-JSON result is a server bug (500), never a 422.
        const targetScene = canonData.scenes.find((s) => s.scene_id === choice.target_scene_id);
        if (!targetScene) {
          throw new CanonInvariantError('Choice target scene missing from canon');
        }
        const toSceneId = new SceneId(choice.target_scene_id);
        const fromSceneId = locked.getCurrentSceneId();
        const validatedState = SessionStateSchema.safeParse(newState);
        if (!validatedState.success) {
          throw new StateInvariantError('Computed choice state failed validation');
        }
        locked.applyChoiceResult(toSceneId, validatedState.data as SessionState, {
          isEndingTarget: targetScene.is_ending,
        });

        // Step 15: construct the COMPLETE response in memory, before any
        // write, so a construction failure still rolls back cleanly.
        const availableChoices: AvailableChoice[] = targetScene.is_ending
          ? []
          : canonData.choices
              .filter((c) => c.scene_id === choice.target_scene_id)
              .filter((c) => isListable(c.conditions, marker, newState))
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((c) => ({
                choiceId: c.choice_id,
                text: c.text,
                sortOrder: c.sort_order,
              }));

        const response: SubmitChoiceResult = {
          sessionId: sessionIdStr,
          version: locked.getVersion(),
          currentSceneId: locked.getCurrentSceneId().getValue(),
          status: locked.getStatus().getValue() as 'active' | 'completed',
          appliedMutations: applied,
          availableChoices,
        };
        const validatedResponse = SubmitChoiceResponseSchema.safeParse(response);
        if (!validatedResponse.success) {
          throw new StateInvariantError('Constructed choice response failed validation');
        }

        // Step 16: persist atomically — session UPDATE (incl. status) +
        // timeline INSERT (envelope) + idempotency INSERT → COMMIT.
        await this.sessions.persistChoiceResult(
          {
            session: locked,
            fromSceneId,
            choiceId: command.choiceId,
            envelope: { kind: 'choice-execution-v1', applied },
          },
          tx
        );
        await this.idempotency.insert(
          {
            idempotencyKey: command.idempotencyKey,
            sessionId: sessionIdStr,
            requestHash: fingerprint,
            response: validatedResponse.data,
          },
          tx
        );

        return validatedResponse.data;
      });

      // Item D: auto-create checkpoint on chapter boundary crossing.
      // Done after commit — checkpoints are append-only history, not critical path.
      if (this.checkpoints) {
        const fromScene = canonData.scenes.find((s) => s.scene_id === session.getCurrentSceneId().getValue());
        const toScene = canonData.scenes.find((s) => s.scene_id === result.currentSceneId);
        if (fromScene && toScene && fromScene.chapter_id !== toScene.chapter_id) {
          // Re-fetch to get post-choice state
          const updatedSession = await this.sessions.findById(command.sessionId);
          if (updatedSession) {
            const { v4: uuidv4 } = await import('uuid');
            await this.checkpoints.save({
              checkpointId: uuidv4(),
              sessionId: sessionIdStr,
              chapterId: toScene.chapter_id,
              chapterTitle: toScene.title,
              sceneId: toScene.scene_id,
              stateVariables: updatedSession.getStateVariables() as Record<string, unknown>,
              version: result.version,
            }).catch(() => {
              // Checkpoint creation is best-effort; never fail the choice submission.
            });
          }
        }
      }

      return result;
    } catch (err) {
      // Step 8 replay: the transaction rolled back; return the stored response.
      if (err instanceof ReplaySignal) {
        return err.response;
      }
      // Step 17: D3a recovery on unique violation.
      if (isUniqueViolation(err)) {
        if (isRetry) {
          // The single bounded retry hit the same race — defensive 500,
          // never a livelock (recursion is structurally impossible).
          throw new StateInvariantError('Idempotency recovery retry conflicted');
        }
        return this.recoverFromUniqueViolation(command, fingerprint);
      }
      throw err;
    }
  }

  /**
   * D3a — unique-violation recovery (ADR-015). Called after `withTransaction`
   * has rolled back the aborted transaction (mandatory first step: the
   * re-read happens after rollback, never inside the failed transaction).
   */
  private async recoverFromUniqueViolation(
    command: SubmitChoiceCommand,
    fingerprint: string
  ): Promise<SubmitChoiceResult> {
    const sessionIdStr = command.sessionId.getValue();
    const rec = await this.idempotency.findUnexpiredByKey(command.idempotencyKey);
    if (rec !== null) {
      // Same comparison rules as the ordinary lookup.
      this.assertReplayable(rec, fingerprint, sessionIdStr);
      return this.validatedReplay(rec);
    }
    // Expired or absent → one bounded retry from step 1. It does not
    // re-enter this recovery algorithm (isRetry=true → defensive 500).
    return this.executeOnce(command, true);
  }

  /** 409 unless the record belongs to this session + fingerprint. */
  private assertReplayable(
    rec: IdempotencyRecord,
    fingerprint: string,
    sessionIdStr: string
  ): void {
    if (rec.requestHash !== fingerprint || rec.sessionId !== sessionIdStr) {
      throw new IdempotencyConflictError(
        'Idempotency key was used for a different submission'
      );
    }
  }

  /**
   * B38: every replay path validates the stored JSONB against the D2
   * response schema first. Corrupt stored data is never served → 500.
   */
  private validatedReplay(rec: IdempotencyRecord): SubmitChoiceResult {
    const parsed = SubmitChoiceResponseSchema.safeParse(rec.response);
    if (!parsed.success) {
      throw new StoredResponseCorruptError(
        `Stored idempotency response failed validation (key=${rec.idempotencyKey})`
      );
    }
    return parsed.data;
  }
}
