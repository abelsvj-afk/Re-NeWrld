import { v4 as uuidv4 } from 'uuid';
import { CharacterRepositoryPort } from '../domain/ports/character.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { Character, CharacterProps } from '../domain/entities/character.entity.js';
import { CharacterAttributes } from '../domain/value-objects/world-schemas.js';
import { CharacterId } from '../domain/value-objects/character-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { CharacterRole } from '../domain/value-objects/character-role.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export interface CreateCharacterInput {
  worldId: string;
  name: string;
  roleTypes: string[];
  description?: string;
  attributes?: Record<string, unknown>;
  creatorId: UserId;
}

export class CreateCharacterUseCase {
  constructor(
    private readonly characterRepository: CharacterRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: CreateCharacterInput): Promise<{ characterId: string }> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(input.creatorId)) {
      throw new WorldNotFoundError();
    }

    const character = Character.create({
      characterId: new CharacterId(uuidv4()),
      worldId,
      name: input.name,
      roleTypes: input.roleTypes.map((r) => new CharacterRole(r)),
      description: input.description ?? null,
      attributes: input.attributes as CharacterAttributes ?? {},
    });

    await this.characterRepository.save(character);
    return { characterId: character.getCharacterId().getValue() };
  }
}
