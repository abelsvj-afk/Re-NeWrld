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
 * Postgres adapter for world choices.
 *
 * Read paths from Task E2a; write paths added in Phase H (H1b).
 * Loads are always scoped to a single world so the validators'
 * same-world precondition holds by construction.
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

  public async findById(choiceId: ChoiceId): Promise<Choice | null> {
    const result = await query<ChoiceRow>(
      `SELECT choice_id, world_id, scene_id, target_scene_id, text, conditions, mutations, sort_order, created_at, updated_at
       FROM choices WHERE choice_id = $1`,
      [choiceId.getValue()]
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToChoice(result.rows[0]);
  }

  public async save(choice: Choice): Promise<void> {
    await query(
      `INSERT INTO choices (choice_id, world_id, scene_id, target_scene_id, text, conditions, mutations, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (choice_id) DO UPDATE SET
         text = EXCLUDED.text,
         target_scene_id = EXCLUDED.target_scene_id,
         conditions = EXCLUDED.conditions,
         mutations = EXCLUDED.mutations,
         sort_order = EXCLUDED.sort_order,
         updated_at = EXCLUDED.updated_at`,
      [
        choice.getChoiceId().getValue(),
        choice.getWorldId().getValue(),
        choice.getSceneId().getValue(),
        choice.getTargetSceneId().getValue(),
        choice.getText(),
        choice.getConditions() ? JSON.stringify(choice.getConditions()) : null,
        choice.getMutations() ? JSON.stringify(choice.getMutations()) : null,
        choice.getSortOrder(),
        choice.getCreatedAt().toISOString(),
        choice.getUpdatedAt().toISOString(),
      ]
    );
  }

  public async delete(choiceId: ChoiceId): Promise<void> {
    await query(`DELETE FROM choices WHERE choice_id = $1`, [choiceId.getValue()]);
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
