import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { ChapterId } from '../domain/value-objects/chapter-id.value-object.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';
import { SceneNotFoundError } from '../domain/errors/world.errors.js';

export interface UpdateSceneInput {
  sceneId: string;
  title?: string;
  prose?: string;
  chapterId?: string;
  isEnding?: boolean;
}

/**
 * Update a scene's content (Phase H, H1b).
 * Only scenes in draft worlds can be modified.
 */
export class UpdateSceneUseCase {
  constructor(
    private readonly sceneRepository: SceneRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: UpdateSceneInput): Promise<void> {
    const sceneId = new SceneId(input.sceneId);
    const scene = await this.sceneRepository.findById(sceneId);
    if (!scene) throw new SceneNotFoundError(input.sceneId);

    const world = await this.worldRepository.findById(scene.getWorldId());
    if (!world) throw new WorldNotFoundError(scene.getWorldId().getValue());
    if (world.getStatus().getValue() !== 'draft') {
      throw new Error('Cannot modify scenes in a non-draft world');
    }

    if (input.title !== undefined) scene.updateTitle(input.title);
    if (input.prose !== undefined) scene.updateProse(input.prose);
    if (input.chapterId !== undefined) scene.updateChapterId(new ChapterId(input.chapterId));
    if (input.isEnding !== undefined) scene.setIsEnding(input.isEnding);

    await this.sceneRepository.save(scene);
  }
}
