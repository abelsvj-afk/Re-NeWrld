import { describe, it, expect, vi } from 'vitest';
import { CreateSceneUseCase } from '../../src/modules/world/application/create-scene.use-case.js';
import { ChapterRepositoryPort } from '../../src/modules/world/domain/ports/chapter.repository.port.js';
import { SceneRepositoryPort } from '../../src/modules/world/domain/ports/scene.repository.port.js';
import { WorldRepositoryPort } from '../../src/modules/world/domain/ports/world.repository.port.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { Chapter } from '../../src/modules/world/domain/entities/chapter.entity.js';
import { Scene } from '../../src/modules/world/domain/entities/scene.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { ChapterId } from '../../src/modules/world/domain/value-objects/chapter-id.value-object.js';
import { WorldStatus } from '../../src/modules/world/domain/value-objects/world-status.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';

const WORLD_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';

function makeWorld() {
  return World.create({
    worldId: new WorldId(WORLD_ID),
    creatorId: new UserId(CREATOR_ID),
    title: 'Test World',
    description: 'desc',
    status: new WorldStatus('draft'),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function makeChapter(chapterId: string, title = 'Chapter 1') {
  return Chapter.create({
    chapterId: new ChapterId(chapterId),
    worldId: new WorldId(WORLD_ID),
    title,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('CreateSceneUseCase — chapter provisioning', () => {
  it('provisions a deterministic default chapter when the world has none', async () => {
    const worldRepository = { findById: vi.fn().mockResolvedValue(makeWorld()) } as unknown as WorldRepositoryPort;
    const savedChapters: Chapter[] = [];
    const chapterRepository = {
      findByWorldId: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockImplementation((c: Chapter) => { savedChapters.push(c); }),
    } as unknown as ChapterRepositoryPort;
    const savedScenes: Scene[] = [];
    const sceneRepository = {
      save: vi.fn().mockImplementation((s: Scene) => { savedScenes.push(s); }),
    } as unknown as SceneRepositoryPort;

    const useCase = new CreateSceneUseCase(sceneRepository, worldRepository, chapterRepository);
    const result = await useCase.execute({
      worldId: WORLD_ID,
      chapterId: '33333333-3333-4333-8333-333333333333',
      title: 'Scene One',
      prose: 'Once upon a time…',
    });

    expect(result.sceneId).toBeTruthy();
    expect(savedChapters).toHaveLength(1);
    expect(savedChapters[0].getTitle()).toBe('Chapter 1');
    expect(savedChapters[0].getWorldId().getValue()).toBe(WORLD_ID);
    expect(savedScenes).toHaveLength(1);
    // Scene must reference the provisioned chapter, not the random client UUID.
    expect(savedScenes[0].getChapterId().getValue()).toBe(savedChapters[0].getChapterId().getValue());
  });

  it('reuses the existing chapter when the world already has one (no duplicate)', async () => {
    const worldRepository = { findById: vi.fn().mockResolvedValue(makeWorld()) } as unknown as WorldRepositoryPort;
    const existing = makeChapter('44444444-4444-4444-8444-444444444444');
    const chapterRepository = {
      findByWorldId: vi.fn().mockResolvedValue([existing]),
      findById: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
    } as unknown as ChapterRepositoryPort;
    const savedScenes: Scene[] = [];
    const sceneRepository = {
      save: vi.fn().mockImplementation((s: Scene) => { savedScenes.push(s); }),
    } as unknown as SceneRepositoryPort;

    const useCase = new CreateSceneUseCase(sceneRepository, worldRepository, chapterRepository);
    await useCase.execute({
      worldId: WORLD_ID,
      chapterId: '55555555-5555-4555-8555-555555555555',
      title: 'Scene Two',
      prose: 'More story…',
    });

    expect(chapterRepository.save).not.toHaveBeenCalled();
    expect(savedScenes[0].getChapterId().getValue()).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('honors a client-supplied chapterId that belongs to this world', async () => {
    const worldRepository = { findById: vi.fn().mockResolvedValue(makeWorld()) } as unknown as WorldRepositoryPort;
    const owned = makeChapter('66666666-6666-4666-8666-666666666666', 'Chapter Two');
    const chapterRepository = {
      findByWorldId: vi.fn(),
      findById: vi.fn().mockResolvedValue(owned),
      save: vi.fn(),
    } as unknown as ChapterRepositoryPort;
    const savedScenes: Scene[] = [];
    const sceneRepository = {
      save: vi.fn().mockImplementation((s: Scene) => { savedScenes.push(s); }),
    } as unknown as SceneRepositoryPort;

    const useCase = new CreateSceneUseCase(sceneRepository, worldRepository, chapterRepository);
    await useCase.execute({
      worldId: WORLD_ID,
      chapterId: '66666666-6666-4666-8666-666666666666',
      title: 'Scene Three',
      prose: 'Even more…',
    });

    expect(chapterRepository.save).not.toHaveBeenCalled();
    expect(savedScenes[0].getChapterId().getValue()).toBe('66666666-6666-4666-8666-666666666666');
  });

  it('falls back to default when the client chapterId belongs to another world', async () => {
    const worldRepository = { findById: vi.fn().mockResolvedValue(makeWorld()) } as unknown as WorldRepositoryPort;
    const foreign = Chapter.create({
      chapterId: new ChapterId('77777777-7777-4777-8777-777777777777'),
      worldId: new WorldId('88888888-8888-4888-8888-888888888888'),
      title: 'Foreign',
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const chapterRepository = {
      findByWorldId: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(foreign),
      save: vi.fn(),
    } as unknown as ChapterRepositoryPort;
    const savedScenes: Scene[] = [];
    const sceneRepository = {
      save: vi.fn().mockImplementation((s: Scene) => { savedScenes.push(s); }),
    } as unknown as SceneRepositoryPort;

    const useCase = new CreateSceneUseCase(sceneRepository, worldRepository, chapterRepository);
    await useCase.execute({
      worldId: WORLD_ID,
      chapterId: '77777777-7777-4777-8777-777777777777',
      title: 'Scene Four',
      prose: 'Story…',
    });

    // Must NOT use the foreign chapter; default was provisioned instead.
    expect(chapterRepository.save).toHaveBeenCalled();
    expect(savedScenes[0].getChapterId().getValue()).not.toBe('77777777-7777-4777-8777-777777777777');
  });

  it('produces the same default chapter ID across calls (deterministic)', async () => {
    const worldRepository = { findById: vi.fn().mockResolvedValue(makeWorld()) } as unknown as WorldRepositoryPort;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const chapterRepository = {
        findByWorldId: vi.fn().mockResolvedValue([]),
        findById: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockImplementation((c: Chapter) => { ids.push(c.getChapterId().getValue()); }),
      } as unknown as ChapterRepositoryPort;
      const sceneRepository = { save: vi.fn() } as unknown as SceneRepositoryPort;
      const useCase = new CreateSceneUseCase(sceneRepository, worldRepository, chapterRepository);
      await useCase.execute({
        worldId: WORLD_ID,
        chapterId: '99999999-9999-4999-8999-999999999999',
        title: `Scene ${i}`,
        prose: 'x',
      });
    }
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});
