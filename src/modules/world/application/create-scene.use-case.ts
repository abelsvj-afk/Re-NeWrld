import { v4 as uuidv4 } from 'uuid';
import { Scene, SceneProps } from '../domain/entities/scene.entity.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { ChapterId } from '../domain/value-objects/chapter-id.value-object.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export interface CreateSceneInput {
  worldId: string;
  chapterId: string;
  title: string;
  prose: string;
  isEnding?: boolean;
}

export interface CreateSceneOutput {
  sceneId: string;
}

/**
 * Create a new scene in a world's draft (Phase H, H1b).
 * Only draft worlds can receive new scenes; published worlds are immutable.
 */
export class CreateSceneUseCase {
  constructor(
    private readonly sceneRepository: SceneRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: CreateSceneInput): Promise<CreateSceneOutput> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world) throw new WorldNotFoundError(input.worldId);
    if (world.getStatus().getValue() !== 'draft') {
      throw new Error('Cannot add scenes to a non-draft world');
    }

    const now = new Date();
    const props: SceneProps = {
      sceneId: new SceneId(uuidv4()),
      worldId,
      chapterId: new ChapterId(input.chapterId),
      title: input.title,
      prose: input.prose,
      metadata: {},
      isEnding: input.isEnding ?? false,
      createdAt: now,
      updatedAt: now,
    };
    const scene = Scene.create(props);
    await this.sceneRepository.save(scene);
    return { sceneId: scene.getSceneId().getValue() };
  }
}
