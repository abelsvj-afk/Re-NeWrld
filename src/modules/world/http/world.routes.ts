import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { World } from '../domain/entities/world.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { WorldMetadataSchema } from '../domain/value-objects/world-schemas.js';
import { CreateWorldUseCase } from '../application/create-world.use-case.js';
import { GetWorldUseCase } from '../application/get-world.use-case.js';
import { UpdateWorldUseCase } from '../application/update-world.use-case.js';
import { DeleteWorldUseCase } from '../application/delete-world.use-case.js';
import { SessionVerifier } from '../../auth/domain/ports/session.port.js';
import { authenticate, requireCreator } from '../../../shared/middleware/auth.middleware.js';
import { BadRequestError } from '../../../shared/http/http.errors.js';

export interface WorldRouteDeps {
  worldRepository: WorldRepositoryPort;
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
  const updateWorld = new UpdateWorldUseCase(deps.worldRepository);
  const deleteWorld = new DeleteWorldUseCase(deps.worldRepository);
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
}
