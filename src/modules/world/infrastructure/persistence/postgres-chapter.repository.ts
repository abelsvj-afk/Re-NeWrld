import { ChapterRepositoryPort } from '../../domain/ports/chapter.repository.port.js';
import { Chapter, ChapterProps } from '../../domain/entities/chapter.entity.js';
import { ChapterId } from '../../domain/value-objects/chapter-id.value-object.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface ChapterRow {
  chapter_id: string;
  world_id: string;
  title: string;
  sort_order: number;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Postgres adapter for world chapters.
 *
 * Minimal surface for the scene-creation ensure-default-chapter path.
 * `save` uses ON CONFLICT DO NOTHING on the (chapter_id, world_id) unique
 * constraint so concurrent default-chapter provisioning is race-safe.
 */
export class PostgresChapterRepository implements ChapterRepositoryPort {
  public async findByWorldId(worldId: WorldId): Promise<Chapter[]> {
    const result = await query<ChapterRow>(
      `SELECT chapter_id, world_id, title, sort_order, created_at, updated_at
       FROM chapters WHERE world_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [worldId.getValue()]
    );

    return result.rows.map((row) => this.mapRowToChapter(row));
  }

  public async findById(chapterId: ChapterId): Promise<Chapter | null> {
    const result = await query<ChapterRow>(
      `SELECT chapter_id, world_id, title, sort_order, created_at, updated_at
       FROM chapters WHERE chapter_id = $1`,
      [chapterId.getValue()]
    );
    if (result.rows.length === 0) return null;
    return this.mapRowToChapter(result.rows[0]);
  }

  public async save(chapter: Chapter): Promise<void> {
    await query(
      `INSERT INTO chapters (chapter_id, world_id, title, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chapter_id, world_id) DO NOTHING`,
      [
        chapter.getChapterId().getValue(),
        chapter.getWorldId().getValue(),
        chapter.getTitle(),
        chapter.getSortOrder(),
        chapter.getCreatedAt().toISOString(),
        chapter.getUpdatedAt().toISOString(),
      ]
    );
  }

  private mapRowToChapter(row: ChapterRow): Chapter {
    const props: ChapterProps = {
      chapterId: new ChapterId(row.chapter_id),
      worldId: new WorldId(row.world_id),
      title: row.title,
      sortOrder: typeof row.sort_order === 'number' ? row.sort_order : 0,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
    return Chapter.create(props);
  }
}
