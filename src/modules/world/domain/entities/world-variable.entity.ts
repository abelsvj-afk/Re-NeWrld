import { WorldValidationError } from '../errors/world.errors.js';
import { WorldId } from '../value-objects/world-id.value-object.js';

export type WorldVariableType = 'boolean' | 'number' | 'string';
export type WorldVariableCategory = 'stat' | 'inventory' | 'relationship' | 'flag' | 'other';

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_NAME_LENGTH = 64;
const MAX_LABEL_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 2000;

export interface WorldVariableProps {
  variableId: string;
  worldId: WorldId;
  name: string;
  type: WorldVariableType;
  defaultValue?: unknown;
  label: string;
  description?: string | null;
  category?: WorldVariableCategory;
  createdAt?: Date;
  updatedAt?: Date;
}

export class WorldVariable {
  private readonly variableId: string;
  private readonly worldId: WorldId;
  private name: string;
  private type: WorldVariableType;
  private defaultValue: unknown;
  private label: string;
  private description: string | null;
  private category: WorldVariableCategory;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: WorldVariableProps) {
    WorldVariable.validateName(props.name);
    WorldVariable.validateType(props.type);
    WorldVariable.validateLabel(props.label);
    if (props.description !== undefined && props.description !== null) {
      WorldVariable.validateDescription(props.description);
    }
    WorldVariable.validateDefaultValue(props.type, props.defaultValue);

    this.variableId = props.variableId;
    this.worldId = props.worldId;
    this.name = props.name;
    this.type = props.type;
    this.defaultValue = props.defaultValue === undefined ? null : structuredClone(props.defaultValue);
    this.label = props.label.trim();
    this.description = props.description ? props.description.trim() : null;
    this.category = props.category ?? 'other';
    this.createdAt = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();
    this.updatedAt = props.updatedAt ? new Date(props.updatedAt.getTime()) : new Date();
  }

  public static create(props: WorldVariableProps): WorldVariable {
    return new WorldVariable(props);
  }

  private static validateName(name: string): void {
    if (!name || typeof name !== 'string') {
      throw new WorldValidationError('Variable name is required');
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new WorldValidationError(`Variable name must be at most ${MAX_NAME_LENGTH} characters`);
    }
    if (!NAME_PATTERN.test(name)) {
      throw new WorldValidationError(
        'Variable name must start with a lowercase letter and contain only lowercase letters, digits, and underscores'
      );
    }
  }

  private static validateType(type: string): void {
    if (type !== 'boolean' && type !== 'number' && type !== 'string') {
      throw new WorldValidationError('Variable type must be boolean, number, or string');
    }
  }

  private static validateLabel(label: string): void {
    if (!label || typeof label !== 'string' || label.trim().length === 0) {
      throw new WorldValidationError('Variable label is required');
    }
    if (label.trim().length > MAX_LABEL_LENGTH) {
      throw new WorldValidationError(`Variable label must be at most ${MAX_LABEL_LENGTH} characters`);
    }
  }

  private static validateDescription(description: string): void {
    if (typeof description !== 'string') {
      throw new WorldValidationError('Variable description must be a string');
    }
    if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
      throw new WorldValidationError(`Variable description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
    }
  }

  private static validateDefaultValue(type: WorldVariableType, value: unknown): void {
    if (value === undefined || value === null) return;
    const actual = typeof value;
    if (type === 'boolean' && actual !== 'boolean') {
      throw new WorldValidationError(`Default value for boolean variable must be a boolean`);
    }
    if (type === 'number' && actual !== 'number') {
      throw new WorldValidationError(`Default value for number variable must be a number`);
    }
    if (type === 'string' && actual !== 'string') {
      throw new WorldValidationError(`Default value for string variable must be a string`);
    }
  }

  public getVariableId(): string {
    return this.variableId;
  }

  public getWorldId(): WorldId {
    return this.worldId;
  }

  public getName(): string {
    return this.name;
  }

  public getType(): WorldVariableType {
    return this.type;
  }

  public getDefaultValue(): unknown {
    return this.defaultValue === null ? undefined : structuredClone(this.defaultValue);
  }

  public getLabel(): string {
    return this.label;
  }

  public getDescription(): string | null {
    return this.description;
  }

  public getCategory(): WorldVariableCategory {
    return this.category;
  }

  public getCreatedAt(): Date {
    return new Date(this.createdAt.getTime());
  }

  public getUpdatedAt(): Date {
    return new Date(this.updatedAt.getTime());
  }

  public updateLabel(label: string): void {
    WorldVariable.validateLabel(label);
    this.label = label.trim();
    this.updatedAt = new Date();
  }

  public updateDescription(description: string | null): void {
    if (description !== null) {
      WorldVariable.validateDescription(description);
    }
    this.description = description ? description.trim() : null;
    this.updatedAt = new Date();
  }

  public updateDefaultValue(value: unknown): void {
    WorldVariable.validateDefaultValue(this.type, value);
    this.defaultValue = value === undefined ? null : structuredClone(value);
    this.updatedAt = new Date();
  }

  public updateCategory(category: WorldVariableCategory): void {
    const valid: WorldVariableCategory[] = ['stat', 'inventory', 'relationship', 'flag', 'other'];
    if (!valid.includes(category)) {
      throw new WorldValidationError('Variable category must be stat, inventory, relationship, flag, or other');
    }
    this.category = category;
    this.updatedAt = new Date();
  }

  /** Rename is allowed but name uniqueness is enforced at the repository level. */
  public updateName(name: string): void {
    WorldVariable.validateName(name);
    this.name = name;
    this.updatedAt = new Date();
  }
}
