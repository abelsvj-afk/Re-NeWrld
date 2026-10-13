import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { World } from '../domain/entities/world.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldMetadata } from '../domain/value-objects/world-schemas.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export interface UpdateWorldCommand {
  worldId: WorldId;
  creatorId: UserId;
  title?: string;
  description?: string | null;
  metadata?: WorldMetadata;
}

export class UpdateWorldUseCase {
  constructor(private readonly worldRepository: WorldRepositoryPort) {}

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

    await this.worldRepository.save(world);
    return world;
  }
}
