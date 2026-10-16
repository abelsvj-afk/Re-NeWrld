import { WorldVariable } from '../entities/world-variable.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';

/**
 * Repository port for the world variable registry (Interactive Narrative Engine, Item B).
 */
export interface WorldVariableRepositoryPort {
  findByWorldId(worldId: WorldId): Promise<WorldVariable[]>;
  findById(variableId: string): Promise<WorldVariable | null>;
  findByName(worldId: WorldId, name: string): Promise<WorldVariable | null>;
  save(variable: WorldVariable): Promise<void>;
  delete(variableId: string): Promise<void>;
}
