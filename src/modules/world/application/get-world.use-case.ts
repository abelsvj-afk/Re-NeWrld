import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { World } from '../domain/entities/world.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export class GetWorldUseCase {
  constructor(private readonly worldRepository: WorldRepositoryPort) {}

  public async execute(worldId: WorldId, creatorId: UserId): Promise<World> {
    const world = await this.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(creatorId)) {
      throw new WorldNotFoundError();
    }
    return world;
  }

  public async executeByCreator(creatorId: UserId): Promise<World[]> {
    return this.worldRepository.findByCreatorId(creatorId);
  }
}
