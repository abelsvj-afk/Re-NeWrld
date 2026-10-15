import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { ChoiceRepositoryPort } from '../domain/ports/choice.repository.port.js';
import { CanonRepositoryPort } from '../domain/ports/canon.repository.port.js';
import { World } from '../domain/entities/world.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { WorldMetadataSchema } from '../domain/value-objects/world-schemas.js';
import { CreateWorldUseCase } from '../application/create-world.use-case.js';
import { GetWorldUseCase } from '../application/get-world.use-case.js';
import { UpdateWorldUseCase } from '../application/update-world.use-case.js';
import { DeleteWorldUseCase } from '../application/delete-world.use-case.js';
import { PublishWorldUseCase } from '../application/publish-world.use-case.js';
import { CreateSceneUseCase } from '../application/create-scene.use-case.js';
import { ChapterRepositoryPort } from '../domain/ports/chapter.repository.port.js';
import { UpdateSceneUseCase } from '../application/update-scene.use-case.js';
import { CreateChoiceUseCase } from '../application/create-choice.use-case.js';
import { SessionVerifier } from '../../auth/domain/ports/session.port.js';
import { authenticate, requireCreator } from '../../../shared/middleware/auth.middleware.js';
import { BadRequestError } from '../../../shared/http/http.errors.js';

export interface WorldRouteDeps {
  worldRepository: WorldRepositoryPort;
  sceneRepository: SceneRepositoryPort;
  chapterRepository: ChapterRepositoryPort;
  choiceRepository: ChoiceRepositoryPort;
  canonRepository: CanonRepositoryPort;
  sessionVerifier: SessionVerifier;
}

const WorldParams = z.object({
  id: z.string().uuid({ message: 'Invalid world id' }),
});

const CreateWorldBody = z.object({
  title: z.string().min(1, { message: 'Title is required' }).max(255),
  description: z.string().max(10000).nullable().optional(),
  metadata: WorldMetadataSchema.optional(),
});

const UpdateWorldBody = z.object({
  title: z.string().min(1, { message: 'Title cannot be empty' }).max(255).optional(),
  description: z.string().max(10000).nullable().optional(),
  metadata: WorldMetadataSchema.optional(),
  startSceneId: z.string().uuid({ message: 'Invalid start scene id' }).nullable().optional(),
});

function parseWorldId(raw: string): WorldId {
  try {
    return new WorldId(raw);
  } catch {
    throw new BadRequestError('Invalid world id');
  }
}

function toWorldJson(world: World) {
  return {
    id: world.getWorldId().getValue(),
    creatorId: world.getCreatorId().getValue(),
    title: world.getTitle(),
    description: world.getDescription(),
    metadata: world.getMetadata(),
    status: world.getStatus().getValue(),
    createdAt: world.getCreatedAt().toISOString(),
    updatedAt: world.getUpdatedAt().toISOString(),
  };
}

export async function worldRoutes(app: FastifyInstance, deps: WorldRouteDeps): Promise<void> {
  const createWorld = new CreateWorldUseCase(deps.worldRepository);
  const getWorld = new GetWorldUseCase(deps.worldRepository);
  const updateWorld = new UpdateWorldUseCase(deps.worldRepository, deps.sceneRepository);
  const deleteWorld = new DeleteWorldUseCase(deps.worldRepository);
  const publishWorld = new PublishWorldUseCase(
    deps.worldRepository,
    deps.sceneRepository,
    deps.choiceRepository,
    deps.canonRepository
  );
  const creatorOnly = [authenticate(deps.sessionVerifier), requireCreator()];

  app.post('/worlds', { preHandler: creatorOnly }, async (request, reply) => {
    const body = CreateWorldBody.parse(request.body);
    const creatorId = request.user!.userId;
    const world = await createWorld.execute({
      creatorId,
      title: body.title,
      description: body.description,
      metadata: body.metadata,
    });
    return reply.code(201).send(toWorldJson(world));
  });

  app.get('/worlds', { preHandler: creatorOnly }, async (request) => {
    const creatorId = request.user!.userId;
    const worlds = await getWorld.executeByCreator(creatorId);
    return { worlds: worlds.map(toWorldJson) };
  });

  app.get('/worlds/:id', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    const world = await getWorld.execute(parseWorldId(params.id), request.user!.userId);
    return toWorldJson(world);
  });

  app.patch('/worlds/:id', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    const body = UpdateWorldBody.parse(request.body);
    const world = await updateWorld.execute({
      worldId: parseWorldId(params.id),
      creatorId: request.user!.userId,
      title: body.title,
      description: body.description,
      metadata: body.metadata,
      startSceneId: body.startSceneId,
    });
    return toWorldJson(world);
  });

  app.delete('/worlds/:id', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    await deleteWorld.execute({
      worldId: parseWorldId(params.id),
      creatorId: request.user!.userId,
    });
    return reply.code(204).send();
  });

  app.post('/worlds/:id/publish', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const result = await publishWorld.execute({
      worldId: parseWorldId(params.id),
      creatorId: request.user!.userId,
    });
    return reply.code(201).send({
      snapshotId: result.snapshot.getSnapshotId().getValue(),
      versionNumber: result.snapshot.getVersionNumber(),
      warnings: result.warnings,
    });
  });

  // --- Scenes (Phase H, H1b) ---
  const CreateSceneBody = z.object({
    chapterId: z.string().uuid(),
    title: z.string().min(1).max(255),
    prose: z.string().min(1),
    isEnding: z.boolean().optional(),
  });

  app.post('/worlds/:id/scenes', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const body = CreateSceneBody.parse(request.body);
    const createScene = new CreateSceneUseCase(deps.sceneRepository, deps.worldRepository, deps.chapterRepository);
    const result = await createScene.execute({ worldId: params.id, ...body });
    return reply.code(201).send(result);
  });

  app.get('/worlds/:id/scenes', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    const scenes = await deps.sceneRepository.findByWorldId(parseWorldId(params.id));
    return scenes.map((s) => ({
      id: s.getSceneId().getValue(),
      worldId: s.getWorldId().getValue(),
      chapterId: s.getChapterId().getValue(),
      title: s.getTitle(),
      prose: s.getProse(),
      isEnding: s.getIsEnding(),
      createdAt: s.getCreatedAt().toISOString(),
      updatedAt: s.getUpdatedAt().toISOString(),
    }));
  });

  const UpdateSceneBody = z.object({
    title: z.string().min(1).max(255).optional(),
    prose: z.string().min(1).optional(),
    chapterId: z.string().uuid().optional(),
    isEnding: z.boolean().optional(),
  });

  app.patch('/worlds/:id/scenes/:sceneId', { preHandler: creatorOnly }, async (request, reply) => {
    const body = UpdateSceneBody.parse(request.body);
    const { sceneId } = request.params as { sceneId: string };
    const updateScene = new UpdateSceneUseCase(deps.sceneRepository, deps.worldRepository);
    await updateScene.execute({ sceneId, ...body });
    return reply.code(204).send();
  });

  // --- Choices (Phase H, H1b) ---
  const CreateChoiceBody = z.object({
    sceneId: z.string().uuid(),
    targetSceneId: z.string().uuid(),
    text: z.string().min(1).max(1000),
    conditions: z.unknown().optional(),
    mutations: z.unknown().optional(),
    sortOrder: z.number().int().optional(),
  });

  app.post('/worlds/:id/choices', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const body = CreateChoiceBody.parse(request.body);
    const createChoice = new CreateChoiceUseCase(
      deps.choiceRepository,
      deps.sceneRepository,
      deps.worldRepository,
    );
    const result = await createChoice.execute({ worldId: params.id, ...body });
    return reply.code(201).send(result);
  });

  app.get('/worlds/:id/choices', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    const choices = await deps.choiceRepository.findByWorldId(parseWorldId(params.id));
    return choices.map((c) => ({
      id: c.getChoiceId().getValue(),
      worldId: c.getWorldId().getValue(),
      sceneId: c.getSceneId().getValue(),
      targetSceneId: c.getTargetSceneId().getValue(),
      text: c.getText(),
      conditions: c.getConditions() ?? null,
      mutations: c.getMutations() ?? null,
      sortOrder: c.getSortOrder(),
    }));
  });
}
