import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorldRepositoryPort } from '../../src/modules/world/domain/ports/world.repository.port.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { CreateWorldUseCase } from '../../src/modules/world/application/create-world.use-case.js';
import { UpdateWorldUseCase } from '../../src/modules/world/application/update-world.use-case.js';
import { GetWorldUseCase } from '../../src/modules/world/application/get-world.use-case.js';
import { WorldNotFoundError, WorldValidationError } from '../../src/modules/world/domain/errors/world.errors.js';

describe('World Authoring Use Cases', () => {
  const creatorId = new UserId('123e4567-e89b-42d3-a456-426614174000');
  const otherCreatorId = new UserId('987fcdeb-5022-42d3-a456-426614174001');

  const mockRepository: WorldRepositoryPort = {
    findById: vi.fn(),
    findByCreatorId: vi.fn(),
    save: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should create a world successfully', async () => {
    const useCase = new CreateWorldUseCase(mockRepository);
    const world = await useCase.execute({
      creatorId,
      title: ' Test Fantasy World ',
      description: ' An epic adventure ',
    });

    expect(world.getTitle()).toBe('Test Fantasy World');
    expect(world.getCreatorId().equals(creatorId)).toBe(true);
    expect(mockRepository.save).toHaveBeenCalledTimes(1);
  });

  it('should update a world when requested by the owning creator', async () => {
    const worldId = WorldId.generate();
    const existingWorld = World.create({
      worldId,
      creatorId,
      title: 'Original Title',
    });

    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);
    vi.spyOn(mockRepository, 'save').mockResolvedValueOnce(undefined);

    const useCase = new UpdateWorldUseCase(mockRepository);
    const updated = await useCase.execute({
      worldId,
      creatorId,
      title: ' Updated Title ',
      description: ' New Description ',
    });

    expect(updated.getTitle()).toBe('Updated Title');
    expect(updated.getDescription()).toBe('New Description');
    expect(mockRepository.save).toHaveBeenCalled();
  });

  it('should throw WorldNotFoundError and NOT call save when updating a non-existent world', async () => {
    const worldId = WorldId.generate();
    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(null);

    const useCase = new UpdateWorldUseCase(mockRepository);
    await expect(
      useCase.execute({
        worldId,
        creatorId,
        title: 'New Title',
      })
    ).rejects.toThrowError(WorldNotFoundError);

    expect(mockRepository.save).not.toHaveBeenCalled();
  });

  it('should throw WorldNotFoundError and NOT call save when updating a world owned by another user', async () => {
    const worldId = WorldId.generate();
    const existingWorld = World.create({
      worldId,
      creatorId,
      title: 'Original Title',
    });

    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);

    const useCase = new UpdateWorldUseCase(mockRepository);
    await expect(
      useCase.execute({
        worldId,
        creatorId: otherCreatorId,
        title: 'Hacked Title',
      })
    ).rejects.toThrowError(WorldNotFoundError);

    expect(mockRepository.save).not.toHaveBeenCalled();
  });

  it('should throw WorldNotFoundError (not-found) when getting a non-existent world', async () => {
    const worldId = WorldId.generate();
    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(null);

    const useCase = new GetWorldUseCase(mockRepository);
    await expect(useCase.execute(worldId, creatorId)).rejects.toThrowError(WorldNotFoundError);
  });

  it('should throw WorldNotFoundError (non-owner) when getting a world owned by another user', async () => {
    const worldId = WorldId.generate();
    const existingWorld = World.create({
      worldId,
      creatorId,
      title: 'Original Title',
    });

    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);

    const useCase = new GetWorldUseCase(mockRepository);
    await expect(useCase.execute(worldId, otherCreatorId)).rejects.toThrowError(WorldNotFoundError);
  });

  it('should ensure not-found and non-owner errors have identical message and statusCode', async () => {
    const worldId = WorldId.generate();
    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(null);
    const useCase = new GetWorldUseCase(mockRepository);

    let errNotFound: any;
    try {
      await useCase.execute(worldId, creatorId);
    } catch (e) {
      errNotFound = e;
    }

    const existingWorld = World.create({ worldId, creatorId, title: 'Title' });
    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);

    let errNonOwner: any;
    try {
      await useCase.execute(worldId, otherCreatorId);
    } catch (e) {
      errNonOwner = e;
    }

    expect(errNotFound).toBeInstanceOf(WorldNotFoundError);
    expect(errNonOwner).toBeInstanceOf(WorldNotFoundError);
    expect(errNotFound.message).toBe(errNonOwner.message);
    expect(errNotFound.statusCode).toBe(errNonOwner.statusCode);
    expect(errNotFound.statusCode).toBe(404);
  });

  it('should retrieve world by ID and by creator', async () => {
    const worldId = WorldId.generate();
    const existingWorld = World.create({
      worldId,
      creatorId,
      title: 'Retrievable World',
    });

    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);
    vi.spyOn(mockRepository, 'findByCreatorId').mockResolvedValueOnce([existingWorld]);

    const useCase = new GetWorldUseCase(mockRepository);
    const found = await useCase.execute(worldId, creatorId);
    expect(found.getTitle()).toBe('Retrievable World');

    const byCreator = await useCase.executeByCreator(creatorId);
    expect(byCreator.length).toBe(1);
    expect(byCreator[0].getTitle()).toBe('Retrievable World');
  });

  it('should reject world title exceeding 255 characters with WorldValidationError and NOT call save', async () => {
    const longTitle = 'a'.repeat(256);
    const worldId = WorldId.generate();
    const existingWorld = World.create({
      worldId,
      creatorId,
      title: 'Valid Title',
    });

    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);
    const useCase = new UpdateWorldUseCase(mockRepository);

    await expect(
      useCase.execute({
        worldId,
        creatorId,
        title: longTitle,
      })
    ).rejects.toThrowError(WorldValidationError);

    expect(mockRepository.save).not.toHaveBeenCalled();

    // Also test creation rejection and updateTitle rejection
    expect(() =>
      World.create({
        worldId: WorldId.generate(),
        creatorId,
        title: longTitle,
      })
    ).toThrowError(WorldValidationError);

    expect(() => existingWorld.updateTitle(longTitle)).toThrowError(WorldValidationError);
  });

  it('should accept world title with exactly 255 characters', () => {
    const title255 = 'a'.repeat(255);
    const world = World.create({
      worldId: WorldId.generate(),
      creatorId,
      title: title255,
    });
    expect(world.getTitle().length).toBe(255);
  });

  it('should reject description exceeding 10000 characters in use cases before repository save is called', async () => {
    const worldId = WorldId.generate();
    const existingWorld = World.create({
      worldId,
      creatorId,
      title: 'Valid Title',
    });

    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);
    const updateUseCase = new UpdateWorldUseCase(mockRepository);

    const longDesc = 'd'.repeat(10001);
    await expect(
      updateUseCase.execute({
        worldId,
        creatorId,
        description: longDesc,
      })
    ).rejects.toThrowError(WorldValidationError);

    expect(mockRepository.save).not.toHaveBeenCalled();

    // Verify CreateWorldUseCase also fails before save
    const createUseCase = new CreateWorldUseCase(mockRepository);
    await expect(
      createUseCase.execute({
        creatorId,
        title: 'New World',
        description: longDesc,
      })
    ).rejects.toThrowError(WorldValidationError);

    expect(mockRepository.save).not.toHaveBeenCalled();
  });

  it('should reject invalid metadata in use cases before repository save is called', async () => {
    const worldId = WorldId.generate();
    const existingWorld = World.create({
      worldId,
      creatorId,
      title: 'Valid Title',
    });

    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);
    const updateUseCase = new UpdateWorldUseCase(mockRepository);

    // Metadata with string exceeding 1000 characters
    const invalidMeta = {
      notes: 'm'.repeat(1001),
    };

    await expect(
      updateUseCase.execute({
        worldId,
        creatorId,
        metadata: invalidMeta,
      })
    ).rejects.toThrow();

    expect(mockRepository.save).not.toHaveBeenCalled();

    // Metadata with depth > 3
    const tooDeepMeta = {
      level1: {
        level2: {
          level3: {
            deep: 'too deep',
          },
        },
      },
    };

    vi.spyOn(mockRepository, 'findById').mockResolvedValueOnce(existingWorld);
    await expect(
      updateUseCase.execute({
        worldId,
        creatorId,
        metadata: tooDeepMeta as any,
      })
    ).rejects.toThrow();

    expect(mockRepository.save).not.toHaveBeenCalled();

    // CreateWorldUseCase with 51 keys metadata fails before save
    const meta51Keys: Record<string, string> = {};
    for (let i = 0; i < 51; i++) {
      meta51Keys[`k${i}`] = `v${i}`;
    }

    const createUseCase = new CreateWorldUseCase(mockRepository);
    await expect(
      createUseCase.execute({
        creatorId,
        title: 'New World',
        metadata: meta51Keys,
      })
    ).rejects.toThrow();

    expect(mockRepository.save).not.toHaveBeenCalled();
  });
});
