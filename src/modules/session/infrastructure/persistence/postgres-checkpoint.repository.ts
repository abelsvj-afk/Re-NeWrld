import {
  CheckpointRepositoryPort,
  SessionCheckpoint,
} from '../../domain/ports/checkpoint.repository.port.js';
import { query } from '../../../../shared/database/db.js';

interface CheckpointRow {
  checkpoint_id: string;
  session_id: string;
  chapter_id: string | null;
  chapter_title: string;
  scene_id: string;
  state_variables: any;
  version: number;
  created_at: string | Date;
}

/**
 * Postgres adapter for session checkpoints (Item D).
 */
export class PostgresCheckpointRepository implements CheckpointRepositoryPort {
  public async findBySessionId(sessionId: string): Promise<SessionCheckpoint[]> {
    const result = await query<CheckpointRow>(
      `SELECT checkpoint_id, session_id, chapter_id, chapter_title, scene_id, state_variables, version, created_at
       FROM session_checkpoints WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  public async findById(checkpointId: string): Promise<SessionCheckpoint | null> {
    const result = await query<CheckpointRow>(
      `SELECT checkpoint_id, session_id, chapter_id, chapter_title, scene_id, state_variables, version, created_at
       FROM session_checkpoints WHERE checkpoint_id = $1`,
      [checkpointId]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  public async save(checkpoint: Omit<SessionCheckpoint, 'createdAt'>): Promise<void> {
    await query(
      `INSERT INTO session_checkpoints (checkpoint_id, session_id, chapter_id, chapter_title, scene_id, state_variables, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (checkpoint_id) DO NOTHING`,
      [
        checkpoint.checkpointId,
        checkpoint.sessionId,
        checkpoint.chapterId,
        checkpoint.chapterTitle,
        checkpoint.sceneId,
        JSON.stringify(checkpoint.stateVariables),
        checkpoint.version,
      ]
    );
  }

  private mapRow(row: CheckpointRow): SessionCheckpoint {
    return {
      checkpointId: row.checkpoint_id,
      sessionId: row.session_id,
      chapterId: row.chapter_id,
      chapterTitle: row.chapter_title,
      sceneId: row.scene_id,
      stateVariables: typeof row.state_variables === 'string' ? JSON.parse(row.state_variables) : row.state_variables,
      version: row.version,
      createdAt: new Date(row.created_at),
    };
  }
}
