import { ChoiceRepositoryPort } from '../domain/ports/choice.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { ChoiceId } from '../domain/value-objects/choice-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { ChoiceNotFoundError } from '../domain/errors/world.errors.js';

export interface DeleteChoiceCommand {
  worldId: WorldId;
  choiceId: ChoiceId;
  creatorId: UserId;
}

export class DeleteChoiceUseCase {
  constructor(
    private readonly choiceRepository: ChoiceRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(command: DeleteChoiceCommand): Promise<void> {
    const world = await this.worldRepository.findById(command.worldId);
    if (!world || !world.getCreatorId().equals(command.creatorId)) {
      throw new ChoiceNotFoundError(command.choiceId.getValue());
    }

    const choice = await this.choiceRepository.findById(command.choiceId);
    if (!choice || !choice.getWorldId().equals(command.worldId)) {
      throw new ChoiceNotFoundError(command.choiceId.getValue());
    }

    await this.choiceRepository.delete(command.choiceId);
  }
}
