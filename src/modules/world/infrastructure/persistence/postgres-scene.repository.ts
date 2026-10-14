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
 * Postgres adapter for world scenes.
 *
 * Read paths from Task E2a; write paths added in Phase H (H1b).
 * Loads are always scoped to a single world so the validators'
 * same-world precondition holds by construction.
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

  public async findById(sceneId: SceneId): Promise<Scene | null> {
    const result = await query<SceneRow>(
      `SELECT scene_id, world_id, chapter_id, title, prose, metadata, is_ending, created_at, updated_at
       FROM scenes WHERE scene_id = $1`,
      [sceneId.getValue()]
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToScene(result.rows[0]);
  }

  public async save(scene: Scene): Promise<void> {
    await query(
      `INSERT INTO scenes (scene_id, world_id, chapter_id, title, prose, metadata, is_ending, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (scene_id) DO UPDATE SET
         title = EXCLUDED.title,
         prose = EXCLUDED.prose,
         metadata = EXCLUDED.metadata,
         is_ending = EXCLUDED.is_ending,
         updated_at = EXCLUDED.updated_at`,
      [
        scene.getSceneId().getValue(),
        scene.getWorldId().getValue(),
        scene.getChapterId().getValue(),
        scene.getTitle(),
        scene.getProse(),
        JSON.stringify(scene.getMetadata()),
        scene.getIsEnding(),
        scene.getCreatedAt().toISOString(),
        scene.getUpdatedAt().toISOString(),
      ]
    );
  }

  public async delete(sceneId: SceneId): Promise<void> {
    await query(`DELETE FROM scenes WHERE scene_id = $1`, [sceneId.getValue()]);
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
