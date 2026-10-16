import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { ChoiceRepositoryPort } from '../domain/ports/choice.repository.port.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';
import {
  validateWorldGraph,
  validateChoiceReferences,
  validateChoiceSemanticsForPublish,
} from '../domain/services/graph-validator.js';

export interface ValidateWorldCommand {
  worldId: WorldId;
  creatorId: UserId;
}

export interface ValidateWorldResult {
  valid: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * Dry-run publishing validation (H-UX4). Runs the same checks as publish
 * without creating a snapshot. Lets creators verify before committing.
 */
export class ValidateWorldUseCase {
  constructor(
    private readonly worlds: WorldRepositoryPort,
    private readonly scenes: SceneRepositoryPort,
    private readonly choices: ChoiceRepositoryPort,
  ) {}

  public async execute(command: ValidateWorldCommand): Promise<ValidateWorldResult> {
    const world = await this.worlds.findById(command.worldId);
    if (world === null || !world.getCreatorId().equals(command.creatorId)) {
      throw new WorldNotFoundError();
    }

    const [scenes, choices] = await Promise.all([
      this.scenes.findByWorldId(world.getWorldId()),
      this.choices.findByWorldId(world.getWorldId()),
    ]);

    const graph = validateWorldGraph(world, scenes, choices);
    const refs = validateChoiceReferences(scenes, choices);
    const semantics = validateChoiceSemanticsForPublish(choices);

    const toMessage = (b: { message?: string } | string): string =>
      typeof b === 'string' ? b : b.message ?? JSON.stringify(b);
    const blockers = [...graph.errors, ...refs.dangling, ...semantics.blockers].map(toMessage);

    return {
      valid: blockers.length === 0,
      blockers,
      warnings: graph.unreachable,
    };
  }
}
