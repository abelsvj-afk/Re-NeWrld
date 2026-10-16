import { WorldVariableRepositoryPort } from '../../domain/ports/world-variable.repository.port.js';
import { WorldVariable, WorldVariableProps, WorldVariableType, WorldVariableCategory } from '../../domain/entities/world-variable.entity.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface WorldVariableRow {
  variable_id: string;
  world_id: string;
  name: string;
  type: string;
  default_value: any;
  label: string;
  description: string | null;
  category: string;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Postgres adapter for the world variable registry (Item B).
 */
export class PostgresWorldVariableRepository implements WorldVariableRepositoryPort {
  public async findByWorldId(worldId: WorldId): Promise<WorldVariable[]> {
    const result = await query<WorldVariableRow>(
      `SELECT variable_id, world_id, name, type, default_value, label, description, category, created_at, updated_at
       FROM world_variables WHERE world_id = $1 ORDER BY name ASC`,
      [worldId.getValue()]
    );
    return result.rows.map((row) => this.mapRowToVariable(row));
  }

  public async findById(variableId: string): Promise<WorldVariable | null> {
    const result = await query<WorldVariableRow>(
      `SELECT variable_id, world_id, name, type, default_value, label, description, category, created_at, updated_at
       FROM world_variables WHERE variable_id = $1`,
      [variableId]
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToVariable(result.rows[0]);
  }

  public async findByName(worldId: WorldId, name: string): Promise<WorldVariable | null> {
    const result = await query<WorldVariableRow>(
      `SELECT variable_id, world_id, name, type, default_value, label, description, category, created_at, updated_at
       FROM world_variables WHERE world_id = $1 AND name = $2`,
      [worldId.getValue(), name]
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToVariable(result.rows[0]);
  }

  public async save(variable: WorldVariable): Promise<void> {
    await query(
      `INSERT INTO world_variables (variable_id, world_id, name, type, default_value, label, description, category, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (variable_id) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         default_value = EXCLUDED.default_value,
         label = EXCLUDED.label,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         updated_at = EXCLUDED.updated_at`,
      [
        variable.getVariableId(),
        variable.getWorldId().getValue(),
        variable.getName(),
        variable.getType(),
        variable.getDefaultValue() === undefined ? null : JSON.stringify(variable.getDefaultValue()),
        variable.getLabel(),
        variable.getDescription(),
        variable.getCategory(),
        variable.getCreatedAt().toISOString(),
        variable.getUpdatedAt().toISOString(),
      ]
    );
  }

  public async delete(variableId: string): Promise<void> {
    await query(`DELETE FROM world_variables WHERE variable_id = $1`, [variableId]);
  }

  private mapRowToVariable(row: WorldVariableRow): WorldVariable {
    let defaultValue: unknown;
    if (row.default_value !== null && row.default_value !== undefined) {
      defaultValue = typeof row.default_value === 'string' ? JSON.parse(row.default_value) : row.default_value;
    }
    const props: WorldVariableProps = {
      variableId: row.variable_id,
      worldId: new WorldId(row.world_id),
      name: row.name,
      type: row.type as WorldVariableType,
      defaultValue,
      label: row.label,
      description: row.description,
      category: row.category as WorldVariableCategory,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
    return WorldVariable.create(props);
  }
}
