import { Choice } from '../entities/choice.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';

/**
 * Read port for world choices (Task E2a).
 *
 * Minimal by design: E2a only needs the world's full choice set for
 * validation and canon serialization. Choice write paths arrive with later
 * authoring phases and are deliberately not declared here.
 */
export interface ChoiceRepositoryPort {
  findByWorldId(worldId: WorldId): Promise<Choice[]>;
}
