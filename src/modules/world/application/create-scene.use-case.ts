import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { Scene, SceneProps } from '../domain/entities/scene.entity.js';
import { Chapter, ChapterProps } from '../domain/entities/chapter.entity.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { ChapterId } from '../domain/value-objects/chapter-id.value-object.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { ChapterRepositoryPort } from '../domain/ports/chapter.repository.port.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';

export interface CreateSceneInput {
  worldId: string;
  chapterId?: string;
  title: string;
  prose: string;
  isEnding?: boolean;
  creatorId: UserId;
}

export interface CreateSceneOutput {
  sceneId: string;
}

/**
 * Derive a deterministic UUIDv4-compatible ID for a world's default chapter.
 * Uses SHA-256 of the world ID with the version/variant bits set per RFC 4122
 * §4.4, so the result passes strict UUIDv4 validation while remaining
 * stable across calls. Combined with INSERT ... ON CONFLICT DO NOTHING,
 * concurrent default-chapter provisioning is race-safe: all callers converge
 * on the same row.
 */
function defaultChapterIdForWorld(worldId: WorldId): ChapterId {
  const hash = createHash('sha256').update(`rene-wrld:default-chapter:${worldId.getValue()}`, 'utf8').digest();
  // Set version nibble to 0100 (v4) and variant bits to 10xx (RFC 4122).
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return new ChapterId(uuid);
}

/**
 * Create a new scene in a world's draft (Phase H, H1b).
 * Only draft worlds can receive new scenes; published worlds are immutable.
 *
 * Chapter provisioning: chapters are required by the scenes FK but chapter
 * authoring (FR-03) is not yet implemented. This use case ensures a valid
 * chapter exists — provisioning a deterministic default ("Chapter 1") when
 * the world has none — so scene creation never fails on the FK constraint.
 * A client-supplied chapterId is honored only if that chapter belongs to
 * this world; otherwise the default is used.
 */
export class CreateSceneUseCase {
  constructor(
    private readonly sceneRepository: SceneRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
    private readonly chapterRepository: ChapterRepositoryPort,
  ) {}

  public async execute(input: CreateSceneInput): Promise<CreateSceneOutput> {
    const worldId = new WorldId(input.worldId);
    const world = await this.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(input.creatorId)) {
      throw new WorldNotFoundError(input.worldId);
    }

    const chapterId = await this.resolveChapterId(worldId, input.chapterId);

    const now = new Date();
    const props: SceneProps = {
      sceneId: new SceneId(uuidv4()),
      worldId,
      chapterId,
      title: input.title,
      prose: input.prose,
      metadata: {},
      isEnding: input.isEnding ?? false,
      createdAt: now,
      updatedAt: now,
    };
    // Validate entity BEFORE reverting world — failed validation must not mutate world status
    const scene = Scene.create(props);

    // Allow adding scenes to published worlds — this reverts to draft
    // so the creator can republish as a new version.
    if (world.getStatus().getValue() === 'published') {
      world.revertToDraft();
      await this.worldRepository.save(world);
    }

    await this.sceneRepository.save(scene);
    return { sceneId: scene.getSceneId().getValue() };
  }

  /**
   * Resolve the effective chapter for a new scene.
   * - If the client-supplied chapterId names a chapter of this world, use it.
   * - Otherwise provision (or reuse) the world's deterministic default chapter.
   */
  private async resolveChapterId(worldId: WorldId, requestedChapterId?: string): Promise<ChapterId> {
    if (requestedChapterId) {
      try {
        const requested = new ChapterId(requestedChapterId);
        const existing = await this.chapterRepository.findById(requested);
        if (existing && existing.getWorldId().equals(worldId)) {
          return requested;
        }
      } catch {
        // Malformed UUID falls through to default provisioning.
      }
    }

    const chapters = await this.chapterRepository.findByWorldId(worldId);
    if (chapters.length > 0) {
      return chapters[0].getChapterId();
    }

    const defaultChapterId = defaultChapterIdForWorld(worldId);
    const now = new Date();
    const chapterProps: ChapterProps = {
      chapterId: defaultChapterId,
      worldId,
      title: 'Chapter 1',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };
    // ON CONFLICT DO NOTHING in the repository makes concurrent
    // provisioning safe: only one row wins, all callers converge.
    await this.chapterRepository.save(Chapter.create(chapterProps));
    return defaultChapterId;
  }
}
