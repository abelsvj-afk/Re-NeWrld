import { Chapter } from '../entities/chapter.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { ChapterId } from '../value-objects/chapter-id.value-object.js';

/**
 * Repository port for world chapters.
 *
 * Minimal surface for the scene-creation ensure-default-chapter path.
 * Full chapter CRUD (FR-03) is a separate future task; this port grows then.
 */
export interface ChapterRepositoryPort {
  findByWorldId(worldId: WorldId): Promise<Chapter[]>;
  findById(chapterId: ChapterId): Promise<Chapter | null>;
  save(chapter: Chapter): Promise<void>;
}
