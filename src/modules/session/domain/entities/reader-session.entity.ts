import { z } from 'zod';
import { SessionId } from '../value-objects/session-id.value-object.js';
import { SessionStatus } from '../value-objects/session-status.value-object.js';
import { WorldId } from '../../../world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../../world/domain/value-objects/scene-id.value-object.js';
import { SnapshotId } from '../../../world/domain/value-objects/snapshot-id.value-object.js';
import { UserId } from '../../../auth/domain/value-objects/user-id.value-object.js';
import {
  SessionValidationError,
  IllegalSessionTransitionError,
} from '../errors/session.errors.js';

/** JSON-serializable gameplay state. NaN/Infinity, undefined, functions and symbols are rejected. */
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);

export const SessionStateSchema = z.record(JsonValueSchema);
export type SessionState = Record<string, unknown>;

export interface ReaderSessionProps {
  sessionId: SessionId;
  readerId: UserId;
  worldId: WorldId;
  snapshotId: SnapshotId;
  currentSceneId: SceneId;
  stateVariables?: SessionState;
  version?: number;
  status?: SessionStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * A reader's playthrough of a published world (Task F1a, ADR-014 D3).
 *
 * The session is pinned to one immutable canon snapshot at creation time —
 * later publishes never move it. Lifecycle is `active → completed` (terminal
 * ending reached) or `active → abandoned` (explicit reader close). Terminal
 * states are absorbing: any transition or mutation attempt on a terminal
 * session throws `IllegalSessionTransitionError`. Terminal sessions remain
 * readable (all getters work in every state).
 *
 * Optimistic locking: `version` starts at 1 and increments only via
 * `applyTransition` (the mechanism F2a's persistence uses with
 * `SELECT ... FOR UPDATE`).
 */
export class ReaderSession {
  private readonly sessionId: SessionId;
  private readonly readerId: UserId;
  private readonly worldId: WorldId;
  private readonly snapshotId: SnapshotId;
  private currentSceneId: SceneId;
  private stateVariables: SessionState;
  private version: number;
  private status: SessionStatus;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: ReaderSessionProps) {
    const version = props.version ?? 1;
    if (!Number.isInteger(version) || version < 1) {
      throw new SessionValidationError('Session version must be a positive integer');
    }
    const validatedState = SessionStateSchema.safeParse(props.stateVariables ?? {});
    if (!validatedState.success) {
      throw new SessionValidationError('Session state variables must be a JSON-serializable object');
    }

    this.sessionId = props.sessionId;
    this.readerId = props.readerId;
    this.worldId = props.worldId;
    this.snapshotId = props.snapshotId;
    this.currentSceneId = props.currentSceneId;
    this.stateVariables = structuredClone(validatedState.data) as SessionState;
    this.version = version;
    this.status = props.status ?? new SessionStatus('active');
    this.createdAt = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();
    this.updatedAt = props.updatedAt ? new Date(props.updatedAt.getTime()) : new Date();
  }

  public static create(props: ReaderSessionProps): ReaderSession {
    return new ReaderSession(props);
  }

  private requireActive(action: string): void {
    if (!this.status.isActive()) {
      throw new IllegalSessionTransitionError(
        `Cannot ${action} a ${this.status.getValue()} session`
      );
    }
  }

  /**
   * Applies a state transition: moves to the next scene, shallow-merges the
   * state diff, and increments the optimistic-locking version. Active sessions
   * only. (Phase G's choice resolution calls this; F2a persists it.)
   */
  public applyTransition(toSceneId: SceneId, stateDiff: SessionState): void {
    this.requireActive('apply a transition to');
    const validated = SessionStateSchema.safeParse(stateDiff);
    if (!validated.success) {
      throw new SessionValidationError('State diff must be a JSON-serializable object');
    }
    this.currentSceneId = toSceneId;
    this.stateVariables = {
      ...this.stateVariables,
      ...(structuredClone(validated.data) as SessionState),
    };
    this.version += 1;
    this.updatedAt = new Date();
  }

  /** Marks the session completed. Only legal from active (terminal ending reached). */
  public complete(): void {
    this.requireActive('complete');
    this.status = new SessionStatus('completed');
    this.updatedAt = new Date();
  }

  /** Marks the session abandoned. Only legal from active (explicit reader close). */
  public abandon(): void {
    this.requireActive('abandon');
    this.status = new SessionStatus('abandoned');
    this.updatedAt = new Date();
  }

  public getSessionId(): SessionId {
    return this.sessionId;
  }

  public getReaderId(): UserId {
    return this.readerId;
  }

  public getWorldId(): WorldId {
    return this.worldId;
  }

  public getSnapshotId(): SnapshotId {
    return this.snapshotId;
  }

  public getCurrentSceneId(): SceneId {
    return this.currentSceneId;
  }

  public getStateVariables(): SessionState {
    return structuredClone(this.stateVariables) as SessionState;
  }

  public getVersion(): number {
    return this.version;
  }

  public getStatus(): SessionStatus {
    return this.status;
  }

  public getCreatedAt(): Date {
    return new Date(this.createdAt.getTime());
  }

  public getUpdatedAt(): Date {
    return new Date(this.updatedAt.getTime());
  }

  public equals(other: ReaderSession | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.sessionId.equals(other.getSessionId());
  }
}
