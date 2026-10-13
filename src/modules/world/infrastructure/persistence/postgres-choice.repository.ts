import { ChoiceRepositoryPort } from '../../domain/ports/choice.repository.port.js';
import { Choice, ChoiceProps } from '../../domain/entities/choice.entity.js';
import { ChoiceId } from '../../domain/value-objects/choice-id.value-object.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../domain/value-objects/scene-id.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface ChoiceRow {
  choice_id: string;
  world_id: string;
  scene_id: string;
  target_scene_id: string;
  text: string;
  conditions: any;
  mutations: any;
  sort_order: number;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Postgres read adapter for world choices (Task E2a).
 *
 * Read-only by design: E2a needs the world's choice set for validation and
 * canon serialization. Loads are always scoped to a single world so the
 * validators' same-world precondition holds by construction.
 */
export class PostgresChoiceRepository implements ChoiceRepositoryPort {
  public async findByWorldId(worldId: WorldId): Promise<Choice[]> {
    const result = await query<ChoiceRow>(
      `SELECT choice_id, world_id, scene_id, target_scene_id, text, conditions, mutations, sort_order, created_at, updated_at
       FROM choices WHERE world_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [worldId.getValue()]
    );

    return result.rows.map((row) => this.mapRowToChoice(row));
  }

  private mapRowToChoice(row: ChoiceRow): Choice {
    const props: ChoiceProps = {
      choiceId: new ChoiceId(row.choice_id),
      worldId: new WorldId(row.world_id),
      sceneId: new SceneId(row.scene_id),
      targetSceneId: new SceneId(row.target_scene_id),
      text: row.text,
      conditions: row.conditions,
      mutations: row.mutations,
      sortOrder: row.sort_order,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    return Choice.create(props);
  }
}
