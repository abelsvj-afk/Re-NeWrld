import { WorldRepositoryPort } from '../../domain/ports/world.repository.port.js';
import { World, WorldProps } from '../../domain/entities/world.entity.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../../auth/domain/value-objects/user-id.value-object.js';
import { WorldStatus } from '../../domain/value-objects/world-status.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface WorldRow {
  world_id: string;
  creator_id: string;
  title: string;
  description: string | null;
  metadata: any;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export class PostgresWorldRepository implements WorldRepositoryPort {
  public async findById(worldId: WorldId): Promise<World | null> {
    const result = await query<WorldRow>(
      `SELECT world_id, creator_id, title, description, metadata, status, created_at, updated_at
       FROM worlds WHERE world_id = $1`,
      [worldId.getValue()]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRowToWorld(result.rows[0]);
  }

  public async findByCreatorId(creatorId: UserId): Promise<World[]> {
    const result = await query<WorldRow>(
      `SELECT world_id, creator_id, title, description, metadata, status, created_at, updated_at
       FROM worlds WHERE creator_id = $1 ORDER BY created_at DESC`,
      [creatorId.getValue()]
    );

    return result.rows.map((row) => this.mapRowToWorld(row));
  }

  public async save(world: World): Promise<void> {
    const worldId = world.getWorldId().getValue();
    const creatorId = world.getCreatorId().getValue();
    const title = world.getTitle();
    const description = world.getDescription();
    const metadata = JSON.stringify(world.getMetadata());
    const status = world.getStatus().getValue();
    const createdAt = world.getCreatedAt();
    const updatedAt = world.getUpdatedAt();

    await query(
      `INSERT INTO worlds (world_id, creator_id, title, description, metadata, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (world_id) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         metadata = EXCLUDED.metadata,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [worldId, creatorId, title, description, metadata, status, createdAt, updatedAt]
    );
  }

  public async delete(worldId: WorldId): Promise<void> {
    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId.getValue()]);
  }

  private mapRowToWorld(row: WorldRow): World {
    const props: WorldProps = {
      worldId: new WorldId(row.world_id),
      creatorId: new UserId(row.creator_id),
      title: row.title,
      description: row.description,
      metadata: row.metadata,
      status: new WorldStatus(row.status),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    return World.create(props);
  }
}
