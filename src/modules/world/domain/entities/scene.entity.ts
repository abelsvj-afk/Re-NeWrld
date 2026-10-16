import { WorldValidationError } from '../errors/world.errors.js';
import { SceneId } from '../value-objects/scene-id.value-object.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { ChapterId } from '../value-objects/chapter-id.value-object.js';
import { SceneMetadata, SceneMetadataSchema } from '../value-objects/world-schemas.js';
import { validateProseTemplate } from '../services/prose-template.js';

export interface SceneProps {
  sceneId: SceneId;
  worldId: WorldId;
  chapterId: ChapterId;
  title: string;
  prose: string;
  metadata?: SceneMetadata;
  isEnding?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Scene {
  private readonly sceneId: SceneId;
  private readonly worldId: WorldId;
  private chapterId: ChapterId;
  private title: string;
  private prose: string;
  private metadata: SceneMetadata;
  private isEnding: boolean;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: SceneProps) {
    if (!props.title || typeof props.title !== 'string' || props.title.trim().length === 0) {
      throw new WorldValidationError('Scene title cannot be empty');
    }
    if (typeof props.prose !== 'string') {
      throw new WorldValidationError('Scene prose must be a string');
    }
    const validatedMetadata = SceneMetadataSchema.parse(props.metadata ?? {});

    this.sceneId = props.sceneId;
    this.worldId = props.worldId;
    this.chapterId = props.chapterId;
    this.title = props.title.trim();
    const templateError = validateProseTemplate(props.prose);
    if (templateError) {
      throw new WorldValidationError(`Invalid prose template: ${templateError}`);
    }
    this.prose = props.prose;
    this.metadata = structuredClone(validatedMetadata);
    this.isEnding = props.isEnding ?? false;
    this.createdAt = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();
    this.updatedAt = props.updatedAt ? new Date(props.updatedAt.getTime()) : new Date();
  }

  public static create(props: SceneProps): Scene {
    return new Scene(props);
  }

  public getSceneId(): SceneId {
    return this.sceneId;
  }

  public getWorldId(): WorldId {
    return this.worldId;
  }

  public getChapterId(): ChapterId {
    return this.chapterId;
  }

  public getTitle(): string {
    return this.title;
  }

  public getProse(): string {
    return this.prose;
  }

  public getMetadata(): SceneMetadata {
    return structuredClone(this.metadata);
  }

  public getIsEnding(): boolean {
    return this.isEnding;
  }

  public getCreatedAt(): Date {
    return new Date(this.createdAt.getTime());
  }

  public getUpdatedAt(): Date {
    return new Date(this.updatedAt.getTime());
  }

  public updateTitle(title: string): void {
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new WorldValidationError('Scene title cannot be empty');
    }
    this.title = title.trim();
    this.updatedAt = new Date();
  }

  public updateProse(prose: string): void {
    if (typeof prose !== 'string') {
      throw new WorldValidationError('Scene prose must be a string');
    }
    // Item A: validate template syntax at save time (fail loud, not at read time)
    const templateError = validateProseTemplate(prose);
    if (templateError) {
      throw new WorldValidationError(`Invalid prose template: ${templateError}`);
    }
    this.prose = prose;
    this.updatedAt = new Date();
  }

  public updateChapterId(chapterId: ChapterId): void {
    this.chapterId = chapterId;
    this.updatedAt = new Date();
  }

  public updateMetadata(metadata: SceneMetadata): void {
    const validated = SceneMetadataSchema.parse(metadata);
    this.metadata = structuredClone(validated);
    this.updatedAt = new Date();
  }

  public setIsEnding(isEnding: boolean): void {
    this.isEnding = isEnding;
    this.updatedAt = new Date();
  }

  public equals(other: Scene | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.sceneId.equals(other.getSceneId());
  }
}
