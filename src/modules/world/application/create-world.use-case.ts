import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { World } from '../domain/entities/world.entity.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldMetadata } from '../domain/value-objects/world-schemas.js';

export interface CreateWorldCommand {
  creatorId: UserId;
  title: string;
  description?: string | null;
  metadata?: WorldMetadata;
}

export class CreateWorldUseCase {
  constructor(private readonly worldRepository: WorldRepositoryPort) {}

  public async execute(command: CreateWorldCommand): Promise<World> {
    const worldId = WorldId.generate();
    const world = World.create({
      worldId,
      creatorId: command.creatorId,
      title: command.title,
      description: command.description,
      metadata: command.metadata,
    });

    await this.worldRepository.save(world);
    return world;
  }
}
