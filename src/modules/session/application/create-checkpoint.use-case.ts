import { v4 as uuidv4 } from 'uuid';
import { CheckpointRepositoryPort } from '../domain/ports/checkpoint.repository.port.js';

export interface CreateCheckpointInput {
  sessionId: string;
  chapterId: string | null;
  chapterTitle: string;
  sceneId: string;
  stateVariables: Record<string, unknown>;
  version: number;
}

/**
 * Creates an immutable checkpoint at a chapter boundary (Item D).
 * Checkpoints are never updated or deleted — they form an append-only history.
 */
export class CreateCheckpointUseCase {
  constructor(
    private readonly checkpoints: CheckpointRepositoryPort,
  ) {}

  public async execute(input: CreateCheckpointInput): Promise<{ checkpointId: string }> {
    const checkpointId = uuidv4();
    await this.checkpoints.save({
      checkpointId,
      sessionId: input.sessionId,
      chapterId: input.chapterId,
      chapterTitle: input.chapterTitle,
      sceneId: input.sceneId,
      stateVariables: input.stateVariables,
      version: input.version,
    });
    return { checkpointId };
  }
}
