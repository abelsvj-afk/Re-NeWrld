import { CharacterRepositoryPort } from '../domain/ports/character.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { CharacterId } from '../domain/value-objects/character-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { CharacterRole } from '../domain/value-objects/character-role.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export interface UpdateCharacterInput {
  worldId: string;
  characterId: string;
  name?: string;
  roleTypes?: string[];
  description?: string | null;
  attributes?: Record<string, unknown>;
  creatorId: UserId;
}

export class UpdateCharacterUseCase {
  constructor(
    private readonly characterRepository: CharacterRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: UpdateCharacterInput): Promise<{ characterId: string }> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(input.creatorId)) {
      throw new WorldNotFoundError();
    }
    if (world.getStatus().getValue() === 'published') {
      world.revertToDraft();
      await this.worldRepository.save(world);
    }

    const character = await this.characterRepository.findById(new CharacterId(input.characterId));
    if (!character) {
      throw new WorldNotFoundError();
    }
    if (!character.getWorldId().equals(worldId)) {
      throw new WorldNotFoundError();
    }

    if (input.name !== undefined) {
      character.updateName(input.name);
    }
    if (input.roleTypes !== undefined) {
      character.updateRoleTypes(input.roleTypes.map((r) => new CharacterRole(r)));
    }
    if (input.description !== undefined) {
      character.updateDescription(input.description);
    }
    if (input.attributes !== undefined) {
      character.updateAttributes(input.attributes as any);
    }

    await this.characterRepository.save(character);

    return { characterId: character.getCharacterId().getValue() };
  }
}
