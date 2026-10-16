import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { SceneNotFoundError } from '../domain/errors/world.errors.js';

export interface DeleteSceneCommand {
  worldId: WorldId;
  sceneId: SceneId;
  creatorId: UserId;
}

export class DeleteSceneUseCase {
  constructor(
    private readonly sceneRepository: SceneRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(command: DeleteSceneCommand): Promise<void> {
    const world = await this.worldRepository.findById(command.worldId);
    if (!world || !world.getCreatorId().equals(command.creatorId)) {
      throw new SceneNotFoundError(command.sceneId.getValue());
    }

    const scene = await this.sceneRepository.findById(command.sceneId);
    if (!scene || !scene.getWorldId().equals(command.worldId)) {
      throw new SceneNotFoundError(command.sceneId.getValue());
    }

    await this.sceneRepository.delete(command.sceneId);
  }
}
