import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { ChoiceRepositoryPort } from '../domain/ports/choice.repository.port.js';
import { CanonRepositoryPort } from '../domain/ports/canon.repository.port.js';
import { World } from '../domain/entities/world.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { WorldMetadataSchema } from '../domain/value-objects/world-schemas.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { CreateWorldUseCase } from '../application/create-world.use-case.js';
import { GetWorldUseCase } from '../application/get-world.use-case.js';
import { UpdateWorldUseCase } from '../application/update-world.use-case.js';
import { DeleteWorldUseCase } from '../application/delete-world.use-case.js';
import { PublishWorldUseCase } from '../application/publish-world.use-case.js';
import { CreateSceneUseCase } from '../application/create-scene.use-case.js';
import { ChapterRepositoryPort } from '../domain/ports/chapter.repository.port.js';
import { UpdateSceneUseCase } from '../application/update-scene.use-case.js';
import { CreateChoiceUseCase } from '../application/create-choice.use-case.js';
import { UpdateChoiceUseCase } from '../application/update-choice.use-case.js';
import { GenerateNarrationUseCase } from '../application/generate-narration.use-case.js';
import { GetNarrationUseCase } from '../application/get-narration.use-case.js';
import { WorldTaxonomyInputSchema } from '../domain/value-objects/world-schemas.js';
import { ListPublishedWorldsUseCase } from '../application/list-published-worlds.use-case.js';
import { DeleteSceneUseCase } from '../application/delete-scene.use-case.js';
import { DeleteChoiceUseCase } from '../application/delete-choice.use-case.js';
import { CharacterRepositoryPort } from '../domain/ports/character.repository.port.js';
import { CreateChapterUseCase } from '../application/create-chapter.use-case.js';
import { CharacterId } from '../domain/value-objects/character-id.value-object.js';
import { ValidateWorldUseCase } from '../application/validate-world.use-case.js';
import { CreateCharacterUseCase } from '../application/create-character.use-case.js';
import { DeleteCharacterUseCase } from '../application/delete-character.use-case.js';
import { UpdateCharacterUseCase } from '../application/update-character.use-case.js';
import { CreateWorldVariableUseCase } from '../application/create-world-variable.use-case.js';
import { UpdateWorldVariableUseCase } from '../application/update-world-variable.use-case.js';
import { DeleteWorldVariableUseCase } from '../application/delete-world-variable.use-case.js';
import { WorldVariableRepositoryPort } from '../domain/ports/world-variable.repository.port.js';
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
  variableRepository: WorldVariableRepositoryPort;
  canonRepository: CanonRepositoryPort;
  narrationRepository: NarrationRepositoryPort;
  elevenLabs: ElevenLabsClient | null;
  narrationStoragePath: string;
  narrationMonthlyCharCap: number;
  mediaStoragePath: string;
  sessionVerifier: SessionVerifier;
}

const WorldParams = z.object({
  id: z.string().uuid({ message: 'Invalid world id' }),
});

/**
 * UPLOAD-1: Detect mimetype from magic bytes (not extension or client mimetype).
 * Returns the mimetype string or null if unrecognized.
 * - JPEG: FF D8 FF
 * - PNG: 89 50 4E 47 0D 0A 1A 0A
 * - WebP: RIFF....WEBP
 * - GIF: GIF87a or GIF89a
 */
function detectMimetypeFromMagic(magic: Buffer): string | null {
  if (magic.length < 4) return null;
  // JPEG
  if (magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG
  if (
    magic.length >= 8 &&
    magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47 &&
    magic[4] === 0x0d && magic[5] === 0x0a && magic[6] === 0x1a && magic[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: RIFF....WEBP
  if (
    magic.length >= 12 &&
    magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46 &&
    magic[8] === 0x57 && magic[9] === 0x45 && magic[10] === 0x42 && magic[11] === 0x50
  ) {
    return 'image/webp';
  }
  // GIF
  if (
    magic.length >= 6 &&
    magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46 &&
    magic[3] === 0x38 && (magic[4] === 0x37 || magic[4] === 0x39) && magic[5] === 0x61
  ) {
    return 'image/gif';
  }
  return null;
}

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

function parseSceneId(raw: string): SceneId {
  try {
    return new SceneId(raw);
  } catch {
    throw new BadRequestError('Invalid scene id');
  }
}

function parseChoiceId(raw: string): ChoiceId {
  try {
    return new ChoiceId(raw);
  } catch {
    throw new BadRequestError('Invalid choice id');
  }
}

function parseCharacterId(raw: string): CharacterId {
  try {
    return new CharacterId(raw);
  } catch {
    throw new BadRequestError('Invalid character id');
  }
}

/**
 * Verify the requester owns the world. Throws WorldNotFoundError (404-not-403)
 * if the world doesn't exist or belongs to another creator.
 */
async function requireWorldOwnership(
  worldRepository: WorldRepositoryPort,
  worldId: WorldId,
  creatorId: UserId
): Promise<void> {
  const world = await worldRepository.findById(worldId);
  if (!world || !world.getCreatorId().equals(creatorId)) {
    throw new WorldNotFoundError(worldId.getValue());
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
    startSceneId: world.getStartSceneId()?.getValue() ?? null,
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
    deps.canonRepository,
    deps.variableRepository
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

  app.patch('/worlds/:id', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const body = UpdateWorldBody.parse(request.body);
    const worldId = params.id;

    // REF-1: Validate coverArtUrl if present in metadata update
    const newCoverUrl = (body.metadata as Record<string, unknown> | undefined)?.coverArtUrl as string | undefined;
    let oldCoverUrl: string | undefined;
    if (newCoverUrl !== undefined) {
      const { validateReferences, ReferenceValidationError, updateAssetRoles } = await import(
        '../domain/services/reference-validator.service.js'
      );
      const { query, withTransaction } = await import('../../../shared/database/db.js');

      // Get current cover URL for role recomputation
      const current = await query(
        `SELECT metadata->>'coverArtUrl' AS url FROM worlds WHERE world_id = $1`,
        [worldId]
      );
      oldCoverUrl = current.rows[0]?.url as string | undefined;

      try {
        await validateReferences(
          worldId,
          oldCoverUrl ? [oldCoverUrl] : [],
          newCoverUrl ? [newCoverUrl] : [],
          {
            isFenceActive: async (tx) => {
              const r = await tx.query(`SELECT active FROM system_maintenance WHERE id = 1`);
              return r.rows.length > 0 && r.rows[0].active === true;
            },
            isBackfillActive: async (tx) => {
              const r = await tx.query(
                `SELECT 1 FROM backfill_runs WHERE state = 'in_progress' LIMIT 1`
              );
              return r.rows.length > 0;
            },
            log: (l, m, d) => request.log[l as 'info'](d, m),
          }
        );
      } catch (err) {
        if (err instanceof ReferenceValidationError) {
          return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }

    const world = await updateWorld.execute({
      worldId: parseWorldId(params.id),
      creatorId: request.user!.userId,
      title: body.title,
      description: body.description,
      metadata: body.metadata,
      startSceneId: body.startSceneId,
    });

    // REF-1 pitfall fix: Update roles after metadata write.
    // Old URL may have lost 'cover' role; new URL gains it.
    if (newCoverUrl !== undefined) {
      const { updateAssetRoles } = await import(
        '../domain/services/reference-validator.service.js'
      );
      const { withTransaction } = await import('../../../shared/database/db.js');
      await withTransaction(async (tx) => {
        for (const url of [oldCoverUrl, newCoverUrl]) {
          if (!url) continue;
          const r = await tx.query(
            `SELECT asset_id FROM world_media_assets WHERE url = $1`,
            [url]
          );
          if (r.rows.length > 0) {
            await updateAssetRoles(r.rows[0].asset_id, url, worldId, tx);
          }
        }
      });
    }

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
    const validateWorld = new ValidateWorldUseCase(deps.worldRepository, deps.sceneRepository, deps.choiceRepository, deps.variableRepository);
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
    prose: z.string().min(1).max(100000),
    isEnding: z.boolean().optional(),
  });

  app.post('/worlds/:id/scenes', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const body = CreateSceneBody.parse(request.body);
    const createScene = new CreateSceneUseCase(deps.sceneRepository, deps.worldRepository, deps.chapterRepository);
    const result = await createScene.execute({ worldId: params.id, creatorId: request.user!.userId, ...body });
    return reply.code(201).send(result);
  });

  app.get('/worlds/:id/scenes', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    await requireWorldOwnership(deps.worldRepository, parseWorldId(params.id), request.user!.userId);
    const scenes = await deps.sceneRepository.findByWorldId(parseWorldId(params.id));
    return scenes.map((s) => ({
      id: s.getSceneId().getValue(),
      worldId: s.getWorldId().getValue(),
      chapterId: s.getChapterId().getValue(),
      title: s.getTitle(),
      prose: s.getProse(),
      isEnding: s.getIsEnding(),
      metadata: s.getMetadata(),
      createdAt: s.getCreatedAt().toISOString(),
      updatedAt: s.getUpdatedAt().toISOString(),
    }));
  });

  const UpdateSceneBody = z.object({
    title: z.string().min(1).max(255).optional(),
    prose: z.string().min(1).max(100000).optional(),
    chapterId: z.string().uuid().optional(),
    isEnding: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  });

  app.patch('/worlds/:id/scenes/:sceneId', { preHandler: creatorOnly }, async (request, reply) => {
    const body = UpdateSceneBody.parse(request.body);
    const params = WorldParams.parse(request.params);
    const { sceneId } = z.object({ sceneId: z.string().uuid() }).parse(request.params);
    const worldId = params.id;

    // REF-1: Validate illustrationUrl if present in metadata update
    const newIllustUrl = (body.metadata as Record<string, unknown> | undefined)?.illustrationUrl as string | undefined;
    let oldIllustUrl: string | undefined;
    if (newIllustUrl !== undefined) {
      const { validateReferences, ReferenceValidationError } = await import(
        '../domain/services/reference-validator.service.js'
      );
      const { query } = await import('../../../shared/database/db.js');

      const current = await query(
        `SELECT metadata->>'illustrationUrl' AS url FROM scenes WHERE scene_id = $1`,
        [sceneId]
      );
      oldIllustUrl = current.rows[0]?.url as string | undefined;

      try {
        await validateReferences(
          worldId,
          oldIllustUrl ? [oldIllustUrl] : [],
          newIllustUrl ? [newIllustUrl] : [],
          {
            isFenceActive: async (tx) => {
              const r = await tx.query(`SELECT active FROM system_maintenance WHERE id = 1`);
              return r.rows.length > 0 && r.rows[0].active === true;
            },
            isBackfillActive: async (tx) => {
              const r = await tx.query(
                `SELECT 1 FROM backfill_runs WHERE state = 'in_progress' LIMIT 1`
              );
              return r.rows.length > 0;
            },
            log: (l, m, d) => request.log[l as 'info'](d, m),
          }
        );
      } catch (err) {
        if (err instanceof ReferenceValidationError) {
          return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }

    const updateScene = new UpdateSceneUseCase(deps.sceneRepository, deps.worldRepository);
    await updateScene.execute({ sceneId, creatorId: request.user!.userId, ...body });

    // REF-1 pitfall fix: Update roles after metadata write.
    if (newIllustUrl !== undefined) {
      const { updateAssetRoles } = await import(
        '../domain/services/reference-validator.service.js'
      );
      const { withTransaction } = await import('../../../shared/database/db.js');
      await withTransaction(async (tx) => {
        for (const url of [oldIllustUrl, newIllustUrl]) {
          if (!url) continue;
          const r = await tx.query(
            `SELECT asset_id FROM world_media_assets WHERE url = $1`,
            [url]
          );
          if (r.rows.length > 0) {
            await updateAssetRoles(r.rows[0].asset_id, url, worldId, tx);
          }
        }
      });
    }

    return reply.code(204).send();
  });

  app.delete('/worlds/:id/scenes/:sceneId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { sceneId } = z.object({ sceneId: z.string().uuid() }).parse(request.params);
    const deleteScene = new DeleteSceneUseCase(deps.sceneRepository, deps.worldRepository);
    await deleteScene.execute({
      worldId: parseWorldId(params.id),
      sceneId: parseSceneId(sceneId),
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
    visibility: z.enum(['hide', 'show_locked']).optional(),
  });

  app.post('/worlds/:id/choices', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const body = CreateChoiceBody.parse(request.body);
    const createChoice = new CreateChoiceUseCase(
      deps.choiceRepository,
      deps.sceneRepository,
      deps.worldRepository,
    );
    const result = await createChoice.execute({ worldId: params.id, creatorId: request.user!.userId, ...body });
    return reply.code(201).send(result);
  });

  app.delete('/worlds/:id/choices/:choiceId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { choiceId } = z.object({ choiceId: z.string().uuid() }).parse(request.params);
    const deleteChoice = new DeleteChoiceUseCase(deps.choiceRepository, deps.worldRepository);
    await deleteChoice.execute({
      worldId: parseWorldId(params.id),
      choiceId: parseChoiceId(choiceId),
      creatorId: request.user!.userId,
    });
    return reply.code(204).send();
  });

  app.patch('/worlds/:id/choices/:choiceId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { choiceId } = z.object({ choiceId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      text: z.string().min(1).max(500).optional(),
      targetSceneId: z.string().uuid().optional(),
      conditions: z.unknown().optional(),
      mutations: z.unknown().optional(),
      sortOrder: z.number().int().optional(),
      visibility: z.enum(['hide', 'show_locked']).optional(),
    }).parse(request.body);
    const updateChoice = new UpdateChoiceUseCase(deps.choiceRepository, deps.sceneRepository, deps.worldRepository);
    const result = await updateChoice.execute({
      worldId: params.id,
      choiceId,
      creatorId: request.user!.userId,
      ...body,
    });
    return reply.code(200).send(result);
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
    await requireWorldOwnership(deps.worldRepository, parseWorldId(params.id), request.user!.userId);
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
      characterId: parseCharacterId(characterId),
      creatorId: request.user!.userId,
    });
    return reply.code(204).send();
  });

  app.patch('/worlds/:id/characters/:characterId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { characterId } = z.object({ characterId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      name: z.string().min(1).max(255).optional(),
      roleTypes: z.array(z.string().min(1)).min(1).optional(),
      description: z.string().max(5000).nullable().optional(),
      attributes: z.record(z.unknown()).optional(),
    }).parse(request.body);
    const updateCharacter = new UpdateCharacterUseCase(deps.characterRepository, deps.worldRepository);
    const result = await updateCharacter.execute({
      worldId: params.id,
      characterId,
      creatorId: request.user!.userId,
      ...body,
    });
    return reply.code(200).send(result);
  });

  // --- World Variable Registry (Item B) ---
  const CreateVariableBody = z.object({
    name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, { message: 'Name must start with a lowercase letter and contain only lowercase letters, digits, and underscores' }),
    type: z.enum(['boolean', 'number', 'string']),
    defaultValue: z.unknown().optional(),
    label: z.string().min(1).max(128),
    description: z.string().max(2000).nullable().optional(),
    category: z.enum(['stat', 'inventory', 'relationship', 'flag', 'other']).optional(),
  });

  const UpdateVariableBody = z.object({
    name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/).optional(),
    label: z.string().min(1).max(128).optional(),
    description: z.string().max(2000).nullable().optional(),
    defaultValue: z.unknown().optional(),
    category: z.enum(['stat', 'inventory', 'relationship', 'flag', 'other']).optional(),
  });

  function toVariableJson(v: { getVariableId(): string; getName(): string; getType(): string; getDefaultValue(): unknown; getLabel(): string; getDescription(): string | null; getCategory(): string }) {
    return {
      id: v.getVariableId(),
      name: v.getName(),
      type: v.getType(),
      defaultValue: v.getDefaultValue() ?? null,
      label: v.getLabel(),
      description: v.getDescription(),
      category: v.getCategory(),
    };
  }

  app.post('/worlds/:id/variables', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const body = CreateVariableBody.parse(request.body);
    const createVariable = new CreateWorldVariableUseCase(deps.variableRepository, deps.worldRepository);
    const result = await createVariable.execute({
      worldId: params.id,
      creatorId: request.user!.userId,
      ...body,
    });
    return reply.code(201).send(result);
  });

  app.get('/worlds/:id/variables', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    await requireWorldOwnership(deps.worldRepository, parseWorldId(params.id), request.user!.userId);
    const variables = await deps.variableRepository.findByWorldId(parseWorldId(params.id));
    return variables.map(toVariableJson);
  });

  app.patch('/worlds/:id/variables/:variableId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { variableId } = z.object({ variableId: z.string().uuid() }).parse(request.params);
    const body = UpdateVariableBody.parse(request.body);
    const updateVariable = new UpdateWorldVariableUseCase(deps.variableRepository, deps.worldRepository);
    const result = await updateVariable.execute({
      worldId: params.id,
      variableId,
      creatorId: request.user!.userId,
      ...body,
    });
    return reply.code(200).send(result);
  });

  app.delete('/worlds/:id/variables/:variableId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { variableId } = z.object({ variableId: z.string().uuid() }).parse(request.params);
    const deleteVariable = new DeleteWorldVariableUseCase(deps.variableRepository, deps.worldRepository);
    await deleteVariable.execute({
      worldId: params.id,
      variableId,
      creatorId: request.user!.userId,
    });
    return reply.code(204).send();
  });

  // --- Chapters ---
  app.post('/worlds/:id/chapters', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const body = z.object({ title: z.string().min(1).max(255) }).parse(request.body);
    const createChapter = new CreateChapterUseCase(deps.chapterRepository, deps.worldRepository);
    const result = await createChapter.execute({
      worldId: params.id,
      title: body.title,
      creatorId: request.user!.userId,
    });
    return reply.code(201).send(result);
  });

  app.get('/worlds/:id/chapters', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    await requireWorldOwnership(deps.worldRepository, parseWorldId(params.id), request.user!.userId);
    const chapters = await deps.chapterRepository.findByWorldId(parseWorldId(params.id));
    return chapters.map((c) => ({
      id: c.getChapterId().getValue(),
      title: c.getTitle(),
      sortOrder: c.getSortOrder(),
    }));
  });

  // --- Media upload (cover art, scene illustrations) ---
  // UPLOAD-1: ADR-017 compliant failure-atomic upload path (design rev 24).
  // Flow: allowance → stream → validate → convert → Phase-A → Phase-B/C → 201.
  // The old direct-write path is REMOVED (no feature flag, no fallback).
  app.post('/worlds/:id/media', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const world = await deps.worldRepository.findById(parseWorldId(params.id));
    if (!world || !world.getCreatorId().equals(request.user!.userId)) {
      return reply.code(404).send({ error: 'World not found' });
    }
    const worldId = params.id;

    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    // Dynamic imports for the upload flow.
    const {
      createAllowance,
      lockStagingFile,
      convertAllowance,
      cancelAllowance,
      stagingPathFor,
      StagingAllowanceError,
    } = await import('../domain/services/staging-allowance.service.js');
    const { getWorldQuotaBytes, checkFileSizeLimit } = await import('../../../shared/config/quota.js');
    const { query, withTransaction } = await import('../../../shared/database/db.js');
    const { createHash } = await import('node:crypto');
    const path = await import('node:path');
    const { v4: uuidv4 } = await import('uuid');

    const mediaRoot = deps.mediaStoragePath;
    const quotaBytes = getWorldQuotaBytes();

    // Staging deps (shared across allowance lifecycle).
    const stagingDeps = {
      quotaBytes,
      maxStagingBytes: 10 * 1024 * 1024,
      allowanceTtlMs: 2 * 60 * 1000,
      mediaRoot,
      isFenceActive: async (tx: any) => {
        const r = await tx.query(`SELECT active FROM system_maintenance WHERE id = 1`);
        return r.rows.length > 0 && r.rows[0].active === true;
      },
      isBackfillActive: async (tx: any) => {
        const r = await tx.query(
          `SELECT 1 FROM backfill_runs WHERE state = 'in_progress' LIMIT 1`
        );
        return r.rows.length > 0;
      },
      quotaUsedBytes: async (wid: string, tx: any) => {
        const r = await tx.query(`SELECT quota_used_bytes($1) AS used`, [wid]);
        return Number(r.rows[0].used);
      },
      lockWorldRow: async (wid: string, tx: any) => {
        const r = await tx.query(`SELECT 1 FROM worlds WHERE world_id = $1 FOR UPDATE`, [wid]);
        if (r.rows.length === 0) throw new Error('World not found');
      },
      createReservation: async (wid: string, sizeBytes: number, bytesReady: boolean, tx: any) => {
        const r = await tx.query(
          `INSERT INTO storage_reservations (world_id, size_bytes, state, bytes_ready)
           VALUES ($1, $2, 'RESERVED', $3) RETURNING reservation_id`,
          [wid, sizeBytes, bytesReady]
        );
        return { reservationId: r.rows[0].reservation_id };
      },
      log: (level: string, msg: string, data?: Record<string, unknown>) =>
        request.log[level as 'info'](data, msg),
    };

    // Step 1: Create staging allowance (BEFORE any bytes accepted).
    let allowance;
    try {
      allowance = await createAllowance(worldId, stagingDeps);
    } catch (err) {
      if (err instanceof StagingAllowanceError) {
        return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
      }
      throw err;
    }

    // Step 2: Lock staging file and stream bytes.
    let stagingFd: any = null;
    let stagingLock: any = null;
    try {
      const locked = await lockStagingFile(mediaRoot, allowance.allowanceId);
      stagingFd = locked.fd;
      stagingLock = locked.handle;

      // Stream the multipart file to the staging file.
      // The multipart plugin enforces the 10 MB cap.
      const buffer = await file.toBuffer();
      checkFileSizeLimit(buffer.length); // 413 if over 10 MB (defense in depth)
      await stagingFd.write(buffer, 0, buffer.length, 0);
      await stagingFd.sync();

      // Step 3: Magic bytes validation (from staged data, not mimetype).
      const magic = buffer.subarray(0, 12);
      const mimetype = detectMimetypeFromMagic(magic);
      if (!mimetype) {
        await cancelAllowance(allowance.allowanceId, mediaRoot, stagingDeps);
        try {
          const { unlink } = await import('node:fs/promises');
          await unlink(stagingPathFor(mediaRoot, allowance.allowanceId));
        } catch { /* ignore */ }
        return reply.code(415).send({ error: 'INVALID_FILE_TYPE', message: 'File content does not match a supported image format' });
      }

      // Step 4: Convert allowance → reservation (atomic).
      // This creates the .part file, transfers bytes, sets bytes_ready=true.
      const { reservationId, sizeBytes } = await convertAllowance(
        allowance.allowanceId,
        worldId,
        stagingFd,
        stagingLock,
        stagingDeps
      );
      // Staging lock/fd released by convertAllowance on success.
      stagingFd = null;
      stagingLock = null;

      // Step 5: Compute content hash for the registry.
      const contentSha256 = createHash('sha256').update(buffer).digest('hex');

      // Step 6: Phase-A — commit reservation to registry (asset PENDING).
      const { commitReservationToRegistry } = await import('../domain/services/quota-handoff.service.js');
      const extByMime: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
      };
      const ext = extByMime[mimetype] ?? '.jpg';
      const filename = `${uuidv4()}${ext}`;

      const { assetId } = await commitReservationToRegistry(
        {
          reservationId,
          worldId,
          filename,
          url: `/media/${filename}`,
          mimetype,
          sizeBytes,
          contentSha256,
        },
        {
          withTransaction,
          log: (l: string, m: string, d?: any) => request.log[l as 'info'](d, m),
          metrics: { handoffTotal: { inc: () => {} } },
        }
      );

      // Step 7: Phase-B/C — link to final location and mark ACTIVE.
      // For UPLOAD-1, the .part file IS the content. Link it to the final path.
      const { phaseBPublish, phaseCMarkActive } = await import('../domain/services/publication.service.js');
      const { tempPathFor } = await import('../domain/services/phase2-writer.service.js');
      const tempPath = tempPathFor(mediaRoot, reservationId);

      await withTransaction(async (tx) => {
        await phaseBPublish(
          {
            reservationId,
            worldId,
            mediaRoot,
            tempPath,
            finalFilename: filename,
            mimetype,
            sizeBytes,
            contentSha256,
          },
          assetId,
          {
            log: (l: string, m: string, d?: any) => request.log[l as 'info'](d, m),
          } as any,
          tx
        );
        await phaseCMarkActive(assetId, tx, {
          log: (l: string, m: string, d?: any) => request.log[l as 'info'](d, m),
        } as any);
      });

      // Step 8: Return 201 ONLY after asset is ACTIVE.
      return reply.code(201).send({ url: `/media/${filename}`, assetId });

    } catch (err) {
      // Cleanup on failure: release staging lock, cancel allowance.
      if (stagingLock) {
        try {
          const { releaseLock } = await import('../../../shared/fs/flock.js');
          await releaseLock(stagingLock);
        } catch { /* ignore */ }
      }
      if (stagingFd) {
        try { await stagingFd.close(); } catch { /* ignore */ }
      }
      if (allowance) {
        try {
          await cancelAllowance(allowance.allowanceId, mediaRoot, stagingDeps);
        } catch { /* ignore */ }
      }
      if (err instanceof StagingAllowanceError) {
        return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
      }
      // QuotaError (from checkFileSizeLimit): 413 FILE_TOO_LARGE, etc.
      const { QuotaError } = await import('../../../shared/config/quota.js');
      if (err instanceof QuotaError) {
        const status = (err as any).httpStatus || (err as any).statusCode || 500;
        return reply.code(status).send({ error: (err as any).code || 'QUOTA_ERROR', message: err.message });
      }
      throw err;
    }
  });

  // DEL-1: Delete a media asset (T1/T2 state machine).
  app.delete('/worlds/:id/media/:assetId', { preHandler: creatorOnly }, async (request, reply) => {
    const params = WorldParams.parse(request.params);
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    const worldId = params.id;
    const mediaRoot = deps.mediaStoragePath;

    // Verify world ownership
    await requireWorldOwnership(deps.worldRepository, parseWorldId(worldId), request.user!.userId);

    const { deleteAsset, DeletionError } = await import(
      '../domain/services/asset-deletion.service.js'
    );

    try {
      await deleteAsset(assetId, worldId, {
        mediaRoot,
        isFenceActive: async (tx) => {
          const r = await tx.query(`SELECT active FROM system_maintenance WHERE id = 1`);
          return r.rows.length > 0 && r.rows[0].active === true;
        },
        isBackfillActive: async (tx) => {
          const r = await tx.query(
            `SELECT 1 FROM backfill_runs WHERE state = 'in_progress' LIMIT 1`
          );
          return r.rows.length > 0;
        },
        log: (l, m, d) => request.log[l as 'info'](d, m),
      });
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof DeletionError) {
        return reply.code(err.httpStatus).send({
          error: err.code,
          message: err.message,
          ...(err.references ? { references: err.references } : {}),
        });
      }
      throw err;
    }
  });

  app.get('/worlds/:id/choices', { preHandler: creatorOnly }, async (request) => {
    const params = WorldParams.parse(request.params);
    await requireWorldOwnership(deps.worldRepository, parseWorldId(params.id), request.user!.userId);
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
      visibility: c.getVisibility(),
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

  app.get('/worlds/:id/scenes/:sceneId/narration/words', async (request, reply) => {
    const params = NarrationParams.parse({ ...request.params as object });
    const getNarration = new GetNarrationUseCase(
      deps.narrationRepository,
      deps.sceneRepository,
      deps.worldRepository,
    );
    const result = await getNarration.execute(params.id, params.sceneId);
    if (!result.found || !result.audioPath) {
      return reply.code(404).send({ error: 'Narration not found' });
    }
    const fs = await import('fs/promises');
    const wordsPath = result.audioPath.replace(/\.mp3$/, '.words.json');
    try {
      const wordsJson = await fs.readFile(wordsPath, 'utf-8');
      return reply
        .header('Content-Type', 'application/json')
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(wordsJson);
    } catch {
      return reply.code(404).send({ error: 'Word timings not available' });
    }
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
    await requireWorldOwnership(deps.worldRepository, worldId, request.user!.userId);
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
