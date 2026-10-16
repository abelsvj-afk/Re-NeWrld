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
import { GenerateNarrationUseCase } from '../application/generate-narration.use-case.js';
import { GetNarrationUseCase } from '../application/get-narration.use-case.js';
import { WorldTaxonomyInputSchema } from '../domain/value-objects/world-schemas.js';
import { ListPublishedWorldsUseCase } from '../application/list-published-worlds.use-case.js';
import { DeleteSceneUseCase } from '../application/delete-scene.use-case.js';
import { DeleteChoiceUseCase } from '../application/delete-choice.use-case.js';
import { CharacterRepositoryPort } from '../domain/ports/character.repository.port.js';
import { CharacterId } from '../domain/value-objects/character-id.value-object.js';
import { ValidateWorldUseCase } from '../application/validate-world.use-case.js';
import { CreateCharacterUseCase } from '../application/create-character.use-case.js';
import { DeleteCharacterUseCase } from '../application/delete-character.use-case.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { ChoiceId } from '../domain/value-objects/choice-id.value-object.js';
import { NarrationRepositoryPort } from '../domain/ports/narration.repository.port.js';
import { ElevenLabsClient, proseToPlainText, sha256Hex } from '../infrastructure/elevenlabs.client.js';
import { SessionVerifier } from '../../auth/domain/ports/session.port.js';
import { authenticate, requireCreator } from '../../../shared/middleware/auth.middleware.js';
import { BadRequestError } from '../../../shared/http/http.errors.js';

export interface WorldRouteDeps {
  worldRepository: WorldRepositoryPort;
  sceneRepository: SceneRepositoryPort;
  chapterRepository: ChapterRepositoryPort;
  choiceRepository: ChoiceRepositoryPort;
  characterRepository: CharacterRepositoryPort;
  canonRepository: CanonRepositoryPort;
  narrationRepository: NarrationRepositoryPort;
  elevenLabs: ElevenLabsClient | null;
  narrationStoragePath: string;
  narrationMonthlyCharCap: number;
  sessionVerifier: SessionVerifier;
}

const WorldParams = z.object({
  id: z.string().uuid({ message: 'Invalid world id' }),
});

const CreateWorldBody = z.object({
  title: z.string().min(1, { message: 'Title is required' }).max(255),
  description: z.string().max(10000).nullable().optional(),
  metadata: WorldMetadataSchema.optional(),
}).superRefine((body, ctx) => {
  // Strict taxonomy validation on write (unknown genre → 400).
  if (body.metadata !== undefined) {
    const result = WorldTaxonomyInputSchema.safeParse({
      genre: (body.metadata as Record<string, unknown>).genre,
      tags: (body.metadata as Record<string, unknown>).tags,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['metadata', ...(issue.path as (string | number)[])] });
      }
    }
  }
});

const UpdateWorldBody = z.object({
  title: z.string().min(1, { message: 'Title cannot be empty' }).max(255).optional(),
  description: z.string().max(10000).nullable().optional(),
  metadata: WorldMetadataSchema.optional(),
  startSceneId: z.string().uuid({ message: 'Invalid start scene id' }).nullable().optional(),
}).superRefine((body, ctx) => {
  if (body.metadata !== undefined) {
    const result = WorldTaxonomyInputSchema.safeParse({
      genre: (body.metadata as Record<string, unknown>).genre,
      tags: (body.metadata as Record<string, unknown>).tags,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['metadata', ...(issue.path as (string | number)[])] });
      }
    }
  }
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

  // Reader catalog: published worlds across all creators (H-UX2).
  // Any authenticated role; drafts never appear. Must precede /worlds/:id.
  const PublishedQuery = z.object({
    genre: z.string().optional(),
    tag: z.string().optional(),
    search: z.string().max(100).optional(),
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
  });

  app.get('/worlds/published', { preHandler: authenticate(deps.sessionVerifier) }, async (request) => {
    const q = PublishedQuery.parse(request.query);
    const listPublished = new ListPublishedWorldsUseCase(deps.worldRepository);
    return listPublished.execute(q);
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

  app.post('/worlds/:id/validate', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    const validateWorld = new ValidateWorldUseCase(deps.worldRepository, deps.sceneRepository, deps.choiceRepository);
    return validateWorld.execute({
      worldId: parseWorldId(params.id),
      creatorId: request.user!.userId,
    });
  });

  app.post('/worlds/:id/publish', { preHandler: creatorOnly }, async (request, reply) => {    const params = WorldParams.parse(request.params);
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
    chapterId: z.string().uuid().optional(),
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

  app.delete('/worlds/:id/scenes/:sceneId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { sceneId } = z.object({ sceneId: z.string().uuid() }).parse(request.params);
    const deleteScene = new DeleteSceneUseCase(deps.sceneRepository, deps.worldRepository);
    await deleteScene.execute({
      worldId: parseWorldId(params.id),
      sceneId: new SceneId(sceneId),
      creatorId: request.user!.userId,
    });
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

  app.delete('/worlds/:id/choices/:choiceId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { choiceId } = z.object({ choiceId: z.string().uuid() }).parse(request.params);
    const deleteChoice = new DeleteChoiceUseCase(deps.choiceRepository, deps.worldRepository);
    await deleteChoice.execute({
      worldId: parseWorldId(params.id),
      choiceId: new ChoiceId(choiceId),
      creatorId: request.user!.userId,
    });
    return reply.code(204).send();
  });

  // --- Characters (US-C03) ---
  const CreateCharacterBody = z.object({
    name: z.string().min(1).max(255),
    roleTypes: z.array(z.string().min(1)).min(1),
    description: z.string().max(5000).optional(),
    attributes: z.record(z.unknown()).optional(),
  });

  app.post('/worlds/:id/characters', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const body = CreateCharacterBody.parse(request.body);
    const createCharacter = new CreateCharacterUseCase(deps.characterRepository, deps.worldRepository);
    const result = await createCharacter.execute({
      worldId: params.id,
      creatorId: request.user!.userId,
      ...body,
    });
    return reply.code(201).send(result);
  });

  app.get('/worlds/:id/characters', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    const characters = await deps.characterRepository.findByWorldId(parseWorldId(params.id));
    return characters.map((c) => ({
      id: c.getCharacterId().getValue(),
      name: c.getName(),
      roleTypes: c.getRoleTypes().map((r) => r.getRoleType()),
      description: c.getDescription(),
      attributes: c.getAttributes(),
    }));
  });

  app.delete('/worlds/:id/characters/:characterId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { characterId } = z.object({ characterId: z.string().uuid() }).parse(request.params);
    const deleteCharacter = new DeleteCharacterUseCase(deps.characterRepository, deps.worldRepository);
    await deleteCharacter.execute({
      worldId: parseWorldId(params.id),
      characterId: new CharacterId(characterId),
      creatorId: request.user!.userId,
    });
    return reply.code(204).send();
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

  // --- Scene narration (ADR-016) ---
  const GenerateNarrationBody = z.object({
    voiceId: z.string().min(1, { message: 'voiceId is required' }).max(64),
    modelId: z.string().min(1).max(64).optional(),
  });

  const NarrationParams = z.object({
    id: z.string().uuid({ message: 'Invalid world id' }),
    sceneId: z.string().uuid({ message: 'Invalid scene id' }),
  });

  app.post('/worlds/:id/scenes/:sceneId/narration', { preHandler: creatorOnly }, async (request, reply) => {
    const params = NarrationParams.parse({ ...request.params as object });
    const body = GenerateNarrationBody.parse(request.body);
    const generate = new GenerateNarrationUseCase({
      narrationRepository: deps.narrationRepository,
      sceneRepository: deps.sceneRepository,
      worldRepository: deps.worldRepository,
      elevenLabs: deps.elevenLabs,
      storagePath: deps.narrationStoragePath,
      monthlyCharCap: deps.narrationMonthlyCharCap,
    });
    const result = await generate.execute({
      worldId: params.id,
      sceneId: params.sceneId,
      creatorId: request.user!.userId,
      voiceId: body.voiceId,
      modelId: body.modelId,
    });
    return reply.code(result.status === 'cached' ? 200 : 202).send(result);
  });

  app.get('/worlds/:id/scenes/:sceneId/narration', async (request, reply) => {
    const params = NarrationParams.parse({ ...request.params as object });
    const getNarration = new GetNarrationUseCase(
      deps.narrationRepository,
      deps.sceneRepository,
      deps.worldRepository,
    );
    const result = await getNarration.execute(params.id, params.sceneId);
    if (!result.found || !result.audio) {
      return reply.code(404).send({ status: 'not_generated' });
    }
    return reply
      .header('Content-Type', 'audio/mpeg')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(result.audio);
  });

  app.get('/worlds/:id/narration/quota', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    const used = await deps.narrationRepository.sumCharactersThisMonth();
    const remaining = deps.elevenLabs ? await deps.elevenLabs.getRemainingQuota() : null;
    return {
      worldId: params.id,
      usedThisMonth: used,
      monthlyCap: deps.narrationMonthlyCharCap,
      providerRemaining: remaining,
      configured: deps.elevenLabs !== null,
    };
  });

  app.get('/worlds/:id/narration/voices', { preHandler: creatorOnly }, async (request) => {
    WorldParams.parse(request.params);
    if (!deps.elevenLabs) {
      return [];
    }
    return deps.elevenLabs.listVoices();
  });

  app.get('/worlds/:id/narration/status', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    const worldId = new WorldId(params.id);
    const scenes = await deps.sceneRepository.findByWorldId(worldId);
    const status: Record<string, boolean> = {};
    for (const scene of scenes) {
      const proseHash = sha256Hex(proseToPlainText(scene.getProse()));
      const cached = await deps.narrationRepository.findLatestByScene(
        worldId, 0, scene.getSceneId(), proseHash
      );
      status[scene.getSceneId().getValue()] = cached !== null;
    }
    return status;
  });
}
