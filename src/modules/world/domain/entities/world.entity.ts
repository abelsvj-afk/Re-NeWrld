import { WorldId } from '../value-objects/world-id.value-object.js';
import { WorldStatus } from '../value-objects/world-status.value-object.js';
import { WorldMetadata, WorldMetadataSchema } from '../value-objects/world-schemas.js';
import { UserId } from '../../../auth/domain/value-objects/user-id.value-object.js';
import { WorldValidationError } from '../errors/world.errors.js';

export interface WorldProps {
  worldId: WorldId;
  creatorId: UserId;
  title: string;
  description?: string | null;
  metadata?: WorldMetadata;
  status?: WorldStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export class World {
  private readonly worldId: WorldId;
  private readonly creatorId: UserId;
  private title: string;
  private description: string | null;
  private metadata: WorldMetadata;
  private status: WorldStatus;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: WorldProps) {
    if (!props.title || typeof props.title !== 'string' || props.title.trim().length === 0) {
      throw new WorldValidationError('World title cannot be empty');
    }
    const trimmedTitle = props.title.trim();
    if (trimmedTitle.length > 255) {
      throw new WorldValidationError('World title cannot exceed 255 characters');
    }
    const validatedDescription = World.validateAndNormalizeDescription(props.description);
    const validatedMetadata = WorldMetadataSchema.parse(props.metadata ?? {});

    this.worldId = props.worldId;
    this.creatorId = props.creatorId;
    this.title = trimmedTitle;
    this.description = validatedDescription;
    this.metadata = structuredClone(validatedMetadata);
    this.status = props.status ?? new WorldStatus('draft');
    this.createdAt = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();
    this.updatedAt = props.updatedAt ? new Date(props.updatedAt.getTime()) : new Date();
  }

  private static validateAndNormalizeDescription(description?: unknown | null): string | null {
    if (description === undefined || description === null) {
      return null;
    }
    if (typeof description !== 'string') {
      throw new WorldValidationError('World description must be a string');
    }
    const trimmed = description.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > 10000) {
      throw new WorldValidationError('World description cannot exceed 10000 characters');
    }
    return trimmed;
  }

  public static create(props: WorldProps): World {
    return new World(props);
  }

  public getWorldId(): WorldId {
    return this.worldId;
  }

  public getCreatorId(): UserId {
    return this.creatorId;
  }

  public getTitle(): string {
    return this.title;
  }

  public getDescription(): string | null {
    return this.description;
  }

  public getMetadata(): WorldMetadata {
    return structuredClone(this.metadata);
  }

  public getStatus(): WorldStatus {
    return this.status;
  }

  public getCreatedAt(): Date {
    return new Date(this.createdAt.getTime());
  }

  public getUpdatedAt(): Date {
    return new Date(this.updatedAt.getTime());
  }

  public updateTitle(title: string): void {
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new WorldValidationError('World title cannot be empty');
    }
    const trimmed = title.trim();
    if (trimmed.length > 255) {
      throw new WorldValidationError('World title cannot exceed 255 characters');
    }
    this.title = trimmed;
    this.updatedAt = new Date();
  }

  public updateDescription(description: string | null): void {
    this.description = World.validateAndNormalizeDescription(description);
    this.updatedAt = new Date();
  }

  public updateMetadata(metadata: WorldMetadata): void {
    const validated = WorldMetadataSchema.parse(metadata);
    this.metadata = structuredClone(validated);
    this.updatedAt = new Date();
  }

  public publish(): void {
    this.status = new WorldStatus('published');
    this.updatedAt = new Date();
  }

  public revertToDraft(): void {
    this.status = new WorldStatus('draft');
    this.updatedAt = new Date();
  }

  public equals(other: World | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.worldId.equals(other.getWorldId());
  }
}
