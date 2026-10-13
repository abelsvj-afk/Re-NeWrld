import { WorldValidationError } from '../errors/world.errors.js';
import { ChapterId } from '../value-objects/chapter-id.value-object.js';
import { WorldId } from '../value-objects/world-id.value-object.js';

export interface ChapterProps {
  chapterId: ChapterId;
  worldId: WorldId;
  title: string;
  sortOrder?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Chapter {
  private readonly chapterId: ChapterId;
  private readonly worldId: WorldId;
  private title: string;
  private sortOrder: number;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: ChapterProps) {
    if (!props.title || typeof props.title !== 'string' || props.title.trim().length === 0) {
      throw new WorldValidationError('Chapter title cannot be empty');
    }
    const order = props.sortOrder ?? 0;
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new WorldValidationError('Chapter sortOrder must be a finite number');
    }

    this.chapterId = props.chapterId;
    this.worldId = props.worldId;
    this.title = props.title.trim();
    this.sortOrder = order;
    this.createdAt = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();
    this.updatedAt = props.updatedAt ? new Date(props.updatedAt.getTime()) : new Date();
  }

  public static create(props: ChapterProps): Chapter {
    return new Chapter(props);
  }

  public getChapterId(): ChapterId {
    return this.chapterId;
  }

  public getWorldId(): WorldId {
    return this.worldId;
  }

  public getTitle(): string {
    return this.title;
  }

  public getSortOrder(): number {
    return this.sortOrder;
  }

  public getCreatedAt(): Date {
    return new Date(this.createdAt.getTime());
  }

  public getUpdatedAt(): Date {
    return new Date(this.updatedAt.getTime());
  }

  public updateTitle(title: string): void {
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new WorldValidationError('Chapter title cannot be empty');
    }
    this.title = title.trim();
    this.updatedAt = new Date();
  }

  public updateSortOrder(sortOrder: number): void {
    if (typeof sortOrder !== 'number' || !Number.isFinite(sortOrder)) {
      throw new WorldValidationError('Chapter sortOrder must be a finite number');
    }
    this.sortOrder = sortOrder;
    this.updatedAt = new Date();
  }

  public equals(other: Chapter | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.chapterId.equals(other.getChapterId());
  }
}
