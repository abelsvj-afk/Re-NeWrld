import { CharacterRepositoryPort } from '../../domain/ports/character.repository.port.js';
import { Character, CharacterProps } from '../../domain/entities/character.entity.js';
import { CharacterId } from '../../domain/value-objects/character-id.value-object.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { CharacterRole } from '../../domain/value-objects/character-role.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface CharacterRow {
  character_id: string;
  world_id: string;
  name: string;
  role_types: any;
  description: string | null;
  attributes: any;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Postgres adapter for world characters (US-C03).
 */
export class PostgresCharacterRepository implements CharacterRepositoryPort {
  public async findByWorldId(worldId: WorldId): Promise<Character[]> {
    const result = await query<CharacterRow>(
      `SELECT character_id, world_id, name, role_types, description, attributes, created_at, updated_at
       FROM characters WHERE world_id = $1 ORDER BY created_at ASC`,
      [worldId.getValue()]
    );
    return result.rows.map((row) => this.mapRowToCharacter(row));
  }

  public async findById(characterId: CharacterId): Promise<Character | null> {
    const result = await query<CharacterRow>(
      `SELECT character_id, world_id, name, role_types, description, attributes, created_at, updated_at
       FROM characters WHERE character_id = $1`,
      [characterId.getValue()]
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToCharacter(result.rows[0]);
  }

  public async save(character: Character): Promise<void> {
    await query(
      `INSERT INTO characters (character_id, world_id, name, role_types, description, attributes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (character_id) DO UPDATE SET
         name = EXCLUDED.name,
         role_types = EXCLUDED.role_types,
         description = EXCLUDED.description,
         attributes = EXCLUDED.attributes,
         updated_at = EXCLUDED.updated_at`,
      [
        character.getCharacterId().getValue(),
        character.getWorldId().getValue(),
        character.getName(),
        JSON.stringify(character.getRoleTypes().map((r) => r.toJson())),
        character.getDescription(),
        JSON.stringify(character.getAttributes()),
        character.getCreatedAt(),
        character.getUpdatedAt(),
      ]
    );
  }

  public async delete(characterId: CharacterId): Promise<void> {
    await query(`DELETE FROM characters WHERE character_id = $1`, [characterId.getValue()]);
  }

  private mapRowToCharacter(row: CharacterRow): Character {
    const props: CharacterProps = {
      characterId: new CharacterId(row.character_id),
      worldId: new WorldId(row.world_id),
      name: row.name,
      roleTypes: (Array.isArray(row.role_types) ? row.role_types : []).map(
        (r: any) => typeof r === 'string'
          ? new CharacterRole(r)
          : new CharacterRole(r.role_type, r.custom_role_name ?? null)
      ),
      description: row.description,
      attributes: typeof row.attributes === 'string' ? JSON.parse(row.attributes) : row.attributes ?? {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
    return Character.create(props);
  }
}
