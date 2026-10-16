import { v4 as uuidv4 } from 'uuid';
import { CheckpointRepositoryPort } from '../domain/ports/checkpoint.repository.port.js';
import { SessionRepositoryPort } from '../domain/ports/session.repository.port.js';
import { SessionId } from '../domain/value-objects/session-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { SessionNotFoundError } from '../domain/errors/session.errors.js';
import { SceneId } from '../../world/domain/value-objects/scene-id.value-object.js';

export interface RewindToCheckpointInput {
  sessionId: string;
  checkpointId: string;
  readerId: UserId;
}

/**
 * Rewinds a session to a checkpoint (Item D).
 * Restores scene and state; the original path remains in the timeline.
 */
export class RewindToCheckpointUseCase {
  constructor(
    private readonly sessions: SessionRepositoryPort,
    private readonly checkpoints: CheckpointRepositoryPort,
  ) {}

  public async execute(input: RewindToCheckpointInput): Promise<{ version: number }> {
    const session = await this.sessions.findById(new SessionId(input.sessionId));
    if (!session || !session.getReaderId().equals(input.readerId)) {
      throw new SessionNotFoundError();
    }

    const checkpoint = await this.checkpoints.findById(input.checkpointId);
    if (!checkpoint || checkpoint.sessionId !== input.sessionId) {
      throw new SessionNotFoundError();
    }

    session.rewindToCheckpoint(
      new SceneId(checkpoint.sceneId),
      checkpoint.stateVariables as any
    );

    await this.sessions.save(session);

    return { version: session.getVersion() };
  }
}
