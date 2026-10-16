import { WorldVariableRepositoryPort } from '../domain/ports/world-variable.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldVariableCategory } from '../domain/entities/world-variable.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError, WorldValidationError } from '../domain/errors/world.errors.js';

export interface UpdateWorldVariableInput {
  worldId: string;
  variableId: string;
  name?: string;
  label?: string;
  description?: string | null;
  defaultValue?: unknown;
  category?: WorldVariableCategory;
  creatorId: UserId;
}

export class UpdateWorldVariableUseCase {
  constructor(
    private readonly variableRepository: WorldVariableRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: UpdateWorldVariableInput): Promise<{ variableId: string }> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(input.creatorId)) {
      throw new WorldNotFoundError();
    }

    const variable = await this.variableRepository.findById(input.variableId);
    if (!variable || !variable.getWorldId().equals(worldId)) {
      throw new WorldNotFoundError();
    }

    if (input.name !== undefined && input.name !== variable.getName()) {
      const existing = await this.variableRepository.findByName(worldId, input.name);
      if (existing) {
        throw new WorldValidationError(`Variable "${input.name}" already exists in this world`);
      }
      variable.updateName(input.name);
    }
    if (input.label !== undefined) {
      variable.updateLabel(input.label);
    }
    if (input.description !== undefined) {
      variable.updateDescription(input.description);
    }
    if (input.defaultValue !== undefined) {
      variable.updateDefaultValue(input.defaultValue);
    }
    if (input.category !== undefined) {
      variable.updateCategory(input.category);
    }

    await this.variableRepository.save(variable);

    if (world.getStatus().getValue() === 'published') {
      world.revertToDraft();
      await this.worldRepository.save(world);
    }

    return { variableId: variable.getVariableId() };
  }
}
