import { v4 as uuidv4 } from 'uuid';
import { Choice, ChoiceProps } from '../domain/entities/choice.entity.js';
import { ChoiceId } from '../domain/value-objects/choice-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { ChoiceRepositoryPort } from '../domain/ports/choice.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldNotFoundError, SceneNotFoundError } from '../domain/errors/world.errors.js';

export interface CreateChoiceInput {
  worldId: string;
  sceneId: string;
  targetSceneId: string;
  text: string;
  conditions?: unknown;
  mutations?: unknown;
  sortOrder?: number;
}

export interface CreateChoiceOutput {
  choiceId: string;
}

/**
 * Create a new choice on a scene (Phase H, H1b).
 * Only draft worlds can receive new choices.
 */
export class CreateChoiceUseCase {
  constructor(
    private readonly choiceRepository: ChoiceRepositoryPort,
    private readonly sceneRepository: SceneRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: CreateChoiceInput): Promise<CreateChoiceOutput> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world) throw new WorldNotFoundError(input.worldId);
    if (world.getStatus().getValue() === 'published') {
      world.revertToDraft();
      await this.worldRepository.save(world);
    }

    const scene = await this.sceneRepository.findById(new SceneId(input.sceneId));
    if (!scene) throw new SceneNotFoundError(input.sceneId);

    const now = new Date();
    const props: ChoiceProps = {
      choiceId: new ChoiceId(uuidv4()),
      worldId,
      sceneId: new SceneId(input.sceneId),
      targetSceneId: new SceneId(input.targetSceneId),
      text: input.text,
      conditions: input.conditions as any,
      mutations: input.mutations as any,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    const choice = Choice.create(props);
    await this.choiceRepository.save(choice);
    return { choiceId: choice.getChoiceId().getValue() };
  }
}
