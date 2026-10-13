import type pkg from 'pg';
import { World } from '../entities/world.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { UserId } from '../../../auth/domain/value-objects/user-id.value-object.js';

export interface WorldRepositoryPort {
  findById(worldId: WorldId): Promise<World | null>;
  findByCreatorId(creatorId: UserId): Promise<World[]>;
  /**
   * Persists a world (insert or upsert). When `tx` is provided, the write
   * joins that transaction; otherwise it uses a pooled connection.
   */
  save(world: World, tx?: pkg.PoolClient): Promise<void>;
  delete(worldId: WorldId): Promise<void>;
}
