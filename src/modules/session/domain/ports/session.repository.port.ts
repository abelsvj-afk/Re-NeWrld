import type pkg from 'pg';
import { ReaderSession } from '../entities/reader-session.entity.js';
import { SessionId } from '../value-objects/session-id.value-object.js';
import { SceneId } from '../../../world/domain/value-objects/scene-id.value-object.js';
import { ChoiceId } from '../../../world/domain/value-objects/choice-id.value-object.js';
import { UserId } from '../../../auth/domain/value-objects/user-id.value-object.js';
import type { AppliedMutation } from '../services/mutation-applier.js';

/**
 * Persistence port for reader sessions (Task F1a).
 *
 * The optional transaction client follows the `WorldRepositoryPort`
 * convention: F2a's atomic state+timeline persistence will pass the
 * transaction client; callers without a transaction use a pooled connection.
 */
export interface SessionRepositoryPort {
  findById(sessionId: SessionId): Promise<ReaderSession | null>;
  findByReaderId(readerId: UserId): Promise<ReaderSession[]>;
  save(session: ReaderSession, tx?: pkg.PoolClient): Promise<void>;

  /**
   * Locks the session row (`SELECT … FOR UPDATE`) and returns the session,
   * or null if it vanished concurrently. The caller owns the transaction.
   * (Task G2c, ADR-015 D3 step 7.)
   */
  findByIdForUpdate(sessionId: SessionId, tx: pkg.PoolClient): Promise<ReaderSession | null>;

  /**
   * Persists a choice execution result (Task G2c, ADR-015 D3 step 16):
   * UPDATEs the session row (scene, state, version, AND status — the F2a
   * UPDATE omits status) and INSERTs the timeline row with the
   * discriminated envelope `{ kind: "choice-execution-v1", applied }`
   * (ADR-015 D1b — not the bare object diff F2a writes). Gapless
   * `MAX+1` sequence under the row lock. The caller owns the transaction;
   * this method issues statements only.
   *
   * The `session` must already have been transitioned via
   * `ReaderSession.applyChoiceResult` — this method never transitions.
   */
  persistChoiceResult(args: PersistChoiceResultArgs, tx: pkg.PoolClient): Promise<void>;
}

/** Timeline envelope for choice execution (ADR-015 D1b). */
export interface ChoiceExecutionEnvelope {
  kind: 'choice-execution-v1';
  applied: AppliedMutation[];
}

export interface PersistChoiceResultArgs {
  /** Already transitioned via `applyChoiceResult`. */
  session: ReaderSession;
  fromSceneId: SceneId;
  choiceId: ChoiceId;
  envelope: ChoiceExecutionEnvelope;
}
