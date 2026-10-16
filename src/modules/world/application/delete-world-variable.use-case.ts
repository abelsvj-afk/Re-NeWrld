import { WorldVariableRepositoryPort } from '../domain/ports/world-variable.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export interface DeleteWorldVariableInput {
  worldId: string;
  variableId: string;
  creatorId: UserId;
}

export class DeleteWorldVariableUseCase {
  constructor(
    private readonly variableRepository: WorldVariableRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: DeleteWorldVariableInput): Promise<void> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(input.creatorId)) {
      throw new WorldNotFoundError();
    }

    const variable = await this.variableRepository.findById(input.variableId);
    if (!variable || !variable.getWorldId().equals(worldId)) {
      throw new WorldNotFoundError();
    }

    await this.variableRepository.delete(input.variableId);

    if (world.getStatus().getValue() === 'published') {
      world.revertToDraft();
      await this.worldRepository.save(world);
    }
  }
}
