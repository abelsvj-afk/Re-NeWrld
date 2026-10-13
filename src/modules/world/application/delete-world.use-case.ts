import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export interface DeleteWorldCommand {
  worldId: WorldId;
  creatorId: UserId;
}

export class DeleteWorldUseCase {
  constructor(private readonly worldRepository: WorldRepositoryPort) {}

  public async execute(command: DeleteWorldCommand): Promise<void> {
    const world = await this.worldRepository.findById(command.worldId);
    // 404-not-403: a world owned by someone else looks the same as a missing
    // one, so creators can't probe for other creators' worlds.
    if (!world || !world.getCreatorId().equals(command.creatorId)) {
      throw new WorldNotFoundError();
    }

    await this.worldRepository.delete(command.worldId);
  }
}
