import {
  WorldRepositoryPort,
  CanonRepositoryPort,
  CanonSnapshot,
  WorldId,
  SceneId,
  WorldNotFoundError,
} from '../../world/application/index.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { ReaderSession } from '../domain/entities/reader-session.entity.js';
import { SessionId } from '../domain/value-objects/session-id.value-object.js';
import { SessionRepositoryPort } from '../domain/ports/session.repository.port.js';
import { NoPublishedSnapshotError } from '../domain/errors/session.errors.js';
import { WorldVariableRepositoryPort } from '../../world/domain/ports/world-variable.repository.port.js';

export interface StartReaderSessionCommand {
  worldId: WorldId;
  /**
   * Derived exclusively from the authenticated session at the route layer
   * (F1c) — never accepted from client input, so ownership cannot be spoofed.
   */
  readerId: UserId;
}

export interface StartReaderSessionResult {
  session: ReaderSession;
  /**
   * The snapshot the session was pinned to (additive, Batch 2). Lets callers
   * (e.g. the F1c route) expose the snapshot's version number without a
   * second query.
   */
  snapshot: CanonSnapshot;
}

/**
 * Starts a new reader playthrough (Task F1b, ADR-014 D1/D2).
 *
 * Resolves the world's latest published snapshot (highest version_number —
 * never inferred from the mutable worlds.status), pins the new session to
 * that snapshot's id and its canon start scene, and persists the session.
 * Later publishes never move the session.
 *
 * - Unknown world → WorldNotFoundError (404).
 * - No published snapshot → NoPublishedSnapshotError (409).
 * - Corrupt latest snapshot → CorruptCanonSnapshotError (500) from the canon
 *   repository; never silently falls back to an older version.
 * - Concurrent initializations each create an independent session
 *   (ADR-013 D2); idempotency-key enforcement is deferred to Phase G.
 */
export class StartReaderSessionUseCase {
  constructor(
    private readonly worlds: WorldRepositoryPort,
    private readonly canon: CanonRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly variables?: WorldVariableRepositoryPort
  ) {}

  public async execute(command: StartReaderSessionCommand): Promise<StartReaderSessionResult> {
    const world = await this.worlds.findById(command.worldId);
    if (world === null) {
      throw new WorldNotFoundError();
    }

    const snapshot = await this.canon.findLatestByWorldId(command.worldId);
    if (snapshot === null) {
      throw new NoPublishedSnapshotError();
    }

    // Item B: initialize session state with registered variable defaults
    let initialState: Record<string, unknown> = {};
    if (this.variables) {
      try {
        const registered = await this.variables.findByWorldId(command.worldId);
        for (const v of registered) {
          const defaultValue = v.getDefaultValue();
          if (defaultValue !== undefined && defaultValue !== null) {
            initialState[v.getName()] = defaultValue;
          }
        }
      } catch {
        // Registry unavailable — start with empty state rather than failing
      }
    }

    const session = ReaderSession.create({
      sessionId: SessionId.generate(),
      readerId: command.readerId,
      worldId: command.worldId,
      snapshotId: snapshot.getSnapshotId(),
      currentSceneId: new SceneId(snapshot.getCanonData().world.start_scene_id),
      stateVariables: initialState,
    });
    await this.sessions.save(session);
    return { session, snapshot };
  }
}
