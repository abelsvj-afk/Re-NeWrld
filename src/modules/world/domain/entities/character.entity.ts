import { CharacterId } from '../value-objects/character-id.value-object.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { CharacterRole } from '../value-objects/character-role.value-object.js';
import { CharacterAttributes, CharacterAttributesSchema } from '../value-objects/world-schemas.js';

export interface CharacterProps {
  characterId: CharacterId;
  worldId: WorldId;
  name: string;
  roleTypes: CharacterRole[];
  description?: string | null;
  attributes?: CharacterAttributes;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Character {
  private readonly characterId: CharacterId;
  private readonly worldId: WorldId;
  private name: string;
  private roleTypes: CharacterRole[];
  private description: string | null;
  private attributes: CharacterAttributes;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: CharacterProps) {
    if (!props.name || typeof props.name !== 'string' || props.name.trim().length === 0) {
      throw new Error('Character name cannot be empty');
    }
    const validatedRoles = Character.validateAndCloneRoles(props.roleTypes);
    const validatedAttributes = CharacterAttributesSchema.parse(props.attributes ?? {});

    this.characterId = props.characterId;
    this.worldId = props.worldId;
    this.name = props.name.trim();
    this.roleTypes = validatedRoles;
    this.description = props.description ? props.description.trim() : null;
    this.attributes = structuredClone(validatedAttributes);
    this.createdAt = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();
    this.updatedAt = props.updatedAt ? new Date(props.updatedAt.getTime()) : new Date();
  }

  private static validateAndCloneRoles(roleTypes: CharacterRole[]): CharacterRole[] {
    if (!roleTypes || !Array.isArray(roleTypes) || roleTypes.length === 0) {
      throw new Error('Character must have at least one role type');
    }
    const seen = new Set<string>();
    const cloned: CharacterRole[] = [];

    for (const r of roleTypes) {
      if (!(r instanceof CharacterRole)) {
        throw new Error('Invalid CharacterRole instance in roleTypes');
      }
      const type = r.getRoleType();
      const key = type === 'custom' ? `custom:${(r.getCustomRoleName() ?? '').trim().toLowerCase()}` : type;

      if (seen.has(key)) {
        throw new Error(`Duplicate character role assignment is prohibited: ${type}${type === 'custom' ? ` (${r.getCustomRoleName()})` : ''}`);
      }
      seen.add(key);
      cloned.push(new CharacterRole(type, r.getCustomRoleName()));
    }
    return cloned;
  }

  public static create(props: CharacterProps): Character {
    return new Character(props);
  }

  public getCharacterId(): CharacterId {
    return this.characterId;
  }

  public getWorldId(): WorldId {
    return this.worldId;
  }

  public getName(): string {
    return this.name;
  }

  public getRoleTypes(): CharacterRole[] {
    return this.roleTypes.map((r) => new CharacterRole(r.getRoleType(), r.getCustomRoleName()));
  }

  public getDescription(): string | null {
    return this.description;
  }

  public getAttributes(): CharacterAttributes {
    return structuredClone(this.attributes);
  }

  public getCreatedAt(): Date {
    return new Date(this.createdAt.getTime());
  }

  public getUpdatedAt(): Date {
    return new Date(this.updatedAt.getTime());
  }

  public updateName(name: string): void {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Character name cannot be empty');
    }
    this.name = name.trim();
    this.updatedAt = new Date();
  }

  public updateRoleTypes(roleTypes: CharacterRole[]): void {
    const validated = Character.validateAndCloneRoles(roleTypes);
    this.roleTypes = validated;
    this.updatedAt = new Date();
  }

  public updateDescription(description: string | null): void {
    this.description = description ? description.trim() : null;
    this.updatedAt = new Date();
  }

  public updateAttributes(attributes: CharacterAttributes): void {
    const validated = CharacterAttributesSchema.parse(attributes);
    this.attributes = structuredClone(validated);
    this.updatedAt = new Date();
  }

  public equals(other: Character | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.characterId.equals(other.getCharacterId());
  }
}
