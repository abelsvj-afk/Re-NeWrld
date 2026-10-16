import { v4 as uuidv4 } from 'uuid';
import { WorldVariableRepositoryPort } from '../domain/ports/world-variable.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldVariable, WorldVariableType, WorldVariableCategory } from '../domain/entities/world-variable.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError, WorldValidationError } from '../domain/errors/world.errors.js';

export interface CreateWorldVariableInput {
  worldId: string;
  name: string;
  type: WorldVariableType;
  defaultValue?: unknown;
  label: string;
  description?: string | null;
  category?: WorldVariableCategory;
  creatorId: UserId;
}

export class CreateWorldVariableUseCase {
  constructor(
    private readonly variableRepository: WorldVariableRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: CreateWorldVariableInput): Promise<{ variableId: string }> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(input.creatorId)) {
      throw new WorldNotFoundError();
    }

    const existing = await this.variableRepository.findByName(worldId, input.name);
    if (existing) {
      throw new WorldValidationError(`Variable "${input.name}" already exists in this world`);
    }

    const variable = WorldVariable.create({
      variableId: uuidv4(),
      worldId,
      name: input.name,
      type: input.type,
      defaultValue: input.defaultValue,
      label: input.label,
      description: input.description,
      category: input.category,
    });

    await this.variableRepository.save(variable);

    if (world.getStatus().getValue() === 'published') {
      world.revertToDraft();
      await this.worldRepository.save(world);
    }

    return { variableId: variable.getVariableId() };
  }
}
