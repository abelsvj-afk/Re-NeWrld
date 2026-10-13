import { World } from '../entities/world.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { UserId } from '../../../auth/domain/value-objects/user-id.value-object.js';

export interface WorldRepositoryPort {
  findById(worldId: WorldId): Promise<World | null>;
  findByCreatorId(creatorId: UserId): Promise<World[]>;
  save(world: World): Promise<void>;
}
