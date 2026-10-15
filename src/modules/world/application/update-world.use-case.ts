import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { World } from '../domain/entities/world.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldMetadata } from '../domain/value-objects/world-schemas.js';
import { WorldNotFoundError, WorldValidationError } from '../domain/errors/world.errors.js';

export interface UpdateWorldCommand {
  worldId: WorldId;
  creatorId: UserId;
  title?: string;
  description?: string | null;
  metadata?: WorldMetadata;
  startSceneId?: string | null;
}

export class UpdateWorldUseCase {
  constructor(
    private readonly worldRepository: WorldRepositoryPort,
    private readonly sceneRepository?: SceneRepositoryPort,
  ) {}

  public async execute(command: UpdateWorldCommand): Promise<World> {
    const world = await this.worldRepository.findById(command.worldId);
    if (!world || !world.getCreatorId().equals(command.creatorId)) {
      throw new WorldNotFoundError();
    }

    if (command.title !== undefined) {
      world.updateTitle(command.title);
    }
    if (command.description !== undefined) {
      world.updateDescription(command.description);
    }
    if (command.metadata !== undefined) {
      world.updateMetadata(command.metadata);
    }
    if (command.startSceneId !== undefined) {
      if (command.startSceneId === null) {
        world.setStartSceneId(null);
      } else {
        const sceneId = new SceneId(command.startSceneId);
        if (!this.sceneRepository) {
          throw new WorldValidationError('Cannot set start scene: scene repository unavailable');
        }
        const scene = await this.sceneRepository.findById(sceneId);
        if (!scene || !scene.getWorldId().equals(command.worldId)) {
          throw new WorldValidationError('Start scene must belong to this world');
        }
        world.setStartSceneId(sceneId);
      }
    }

    await this.worldRepository.save(world);
    return world;
  }
}
