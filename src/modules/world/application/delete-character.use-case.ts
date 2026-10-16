import { CharacterRepositoryPort } from '../domain/ports/character.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { CharacterId } from '../domain/value-objects/character-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export interface DeleteCharacterCommand {
  worldId: WorldId;
  characterId: CharacterId;
  creatorId: UserId;
}

export class DeleteCharacterUseCase {
  constructor(
    private readonly characterRepository: CharacterRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(command: DeleteCharacterCommand): Promise<void> {
    const world = await this.worldRepository.findById(command.worldId);
    if (!world || !world.getCreatorId().equals(command.creatorId)) {
      throw new WorldNotFoundError();
    }

    const character = await this.characterRepository.findById(command.characterId);
    if (!character || !character.getWorldId().equals(command.worldId)) {
      throw new WorldNotFoundError();
    }

    await this.characterRepository.delete(command.characterId);
  }
}
