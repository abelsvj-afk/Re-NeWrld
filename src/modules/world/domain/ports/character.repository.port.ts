import { Character } from '../entities/character.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { CharacterId } from '../value-objects/character-id.value-object.js';

/**
 * Repository port for world characters (US-C03).
 */
export interface CharacterRepositoryPort {
  findByWorldId(worldId: WorldId): Promise<Character[]>;
  findById(characterId: CharacterId): Promise<Character | null>;
  save(character: Character): Promise<void>;
  delete(characterId: CharacterId): Promise<void>;
}
