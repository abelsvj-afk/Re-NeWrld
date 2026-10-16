import { v4 as uuidv4 } from 'uuid';
import { ChapterRepositoryPort } from '../domain/ports/chapter.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { Chapter } from '../domain/entities/chapter.entity.js';
import { ChapterId } from '../domain/value-objects/chapter-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';

export interface CreateChapterInput {
  worldId: string;
  title: string;
  sortOrder?: number;
  creatorId: UserId;
}

export class CreateChapterUseCase {
  constructor(
    private readonly chapterRepository: ChapterRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(input: CreateChapterInput): Promise<{ chapterId: string }> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(input.creatorId)) {
      throw new WorldNotFoundError();
    }

    const existing = await this.chapterRepository.findByWorldId(worldId);
    const chapter = Chapter.create({
      chapterId: new ChapterId(uuidv4()),
      worldId,
      title: input.title,
      sortOrder: input.sortOrder ?? existing.length,
    });

    await this.chapterRepository.save(chapter);
    return { chapterId: chapter.getChapterId().getValue() };
  }
}
