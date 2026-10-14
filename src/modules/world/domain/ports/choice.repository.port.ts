import { Choice } from '../entities/choice.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { ChoiceId } from '../value-objects/choice-id.value-object.js';

/**
 * Repository port for world choices.
 *
 * Read paths from Task E2a; write paths added in Phase H (H1b) for the
 * creator choice editor.
 */
export interface ChoiceRepositoryPort {
  findByWorldId(worldId: WorldId): Promise<Choice[]>;
  findById(choiceId: ChoiceId): Promise<Choice | null>;
  save(choice: Choice): Promise<void>;
  delete(choiceId: ChoiceId): Promise<void>;
}
