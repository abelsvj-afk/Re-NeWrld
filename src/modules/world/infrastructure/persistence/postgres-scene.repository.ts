import { SceneRepositoryPort } from '../../domain/ports/scene.repository.port.js';
import { Scene, SceneProps } from '../../domain/entities/scene.entity.js';
import { SceneId } from '../../domain/value-objects/scene-id.value-object.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { ChapterId } from '../../domain/value-objects/chapter-id.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface SceneRow {
  scene_id: string;
  world_id: string;
  chapter_id: string;
  title: string;
  prose: string;
  metadata: any;
  is_ending: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Postgres read adapter for world scenes (Task E2a).
 *
 * Read-only by design: E2a needs the world's scene set for validation and
 * canon serialization. Loads are always scoped to a single world so the
 * validators' same-world precondition holds by construction.
 */
export class PostgresSceneRepository implements SceneRepositoryPort {
  public async findByWorldId(worldId: WorldId): Promise<Scene[]> {
    const result = await query<SceneRow>(
      `SELECT scene_id, world_id, chapter_id, title, prose, metadata, is_ending, created_at, updated_at
       FROM scenes WHERE world_id = $1 ORDER BY created_at ASC`,
      [worldId.getValue()]
    );

    return result.rows.map((row) => this.mapRowToScene(row));
  }

  private mapRowToScene(row: SceneRow): Scene {
    const props: SceneProps = {
      sceneId: new SceneId(row.scene_id),
      worldId: new WorldId(row.world_id),
      chapterId: new ChapterId(row.chapter_id),
      title: row.title,
      prose: row.prose,
      metadata: row.metadata,
      isEnding: row.is_ending,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    return Scene.create(props);
  }
}
