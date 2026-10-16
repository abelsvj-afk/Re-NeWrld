import { ChoiceId } from '../domain/value-objects/choice-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { ChoiceRepositoryPort } from '../domain/ports/choice.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { WorldNotFoundError, ChoiceNotFoundError, SceneNotFoundError } from '../domain/errors/world.errors.js';

export interface UpdateChoiceInput {
  worldId: string;
  choiceId: string;
  text?: string;
  targetSceneId?: string;
  conditions?: unknown;
  mutations?: unknown;
  sortOrder?: number;
  visibility?: 'hide' | 'show_locked';
}

export interface UpdateChoiceOutput {
  choiceId: string;
}

/**
 * Update an existing choice.
 * If the world is published, it reverts to draft (same as create/delete).
 */
export class UpdateChoiceUseCase {
  constructor(
    private readonly choiceRepository: ChoiceRepositoryPort,
    private readonly sceneRepository: SceneRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: UpdateChoiceInput): Promise<UpdateChoiceOutput> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world) throw new WorldNotFoundError(input.worldId);
    if (world.getStatus().getValue() === 'published') {
      world.revertToDraft();
      await this.worldRepository.save(world);
    }

    const choice = await this.choiceRepository.findById(new ChoiceId(input.choiceId));
    if (!choice) throw new ChoiceNotFoundError(input.choiceId);

    if (input.text !== undefined) {
      choice.updateText(input.text);
    }
    if (input.targetSceneId !== undefined) {
      const targetScene = await this.sceneRepository.findById(new SceneId(input.targetSceneId));
      if (!targetScene) throw new SceneNotFoundError(input.targetSceneId);
      choice.updateTargetSceneId(new SceneId(input.targetSceneId));
    }
    if (input.conditions !== undefined) {
      choice.updateConditions(input.conditions as any);
    }
    if (input.mutations !== undefined) {
      choice.updateMutations(input.mutations as any);
    }
    if (input.sortOrder !== undefined) {
      choice.updateSortOrder(input.sortOrder);
    }
    if (input.visibility !== undefined) {
      choice.updateVisibility(input.visibility);
    }

    await this.choiceRepository.save(choice);

    return { choiceId: choice.getChoiceId().getValue() };
  }
}
