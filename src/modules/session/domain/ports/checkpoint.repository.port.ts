export interface SessionCheckpoint {
  checkpointId: string;
  sessionId: string;
  chapterId: string | null;
  chapterTitle: string;
  sceneId: string;
  stateVariables: Record<string, unknown>;
  version: number;
  createdAt: Date;
}

/**
 * Repository port for session checkpoints (Item D).
 */
export interface CheckpointRepositoryPort {
  findBySessionId(sessionId: string): Promise<SessionCheckpoint[]>;
  findById(checkpointId: string): Promise<SessionCheckpoint | null>;
  save(checkpoint: Omit<SessionCheckpoint, 'createdAt'>): Promise<void>;
}
