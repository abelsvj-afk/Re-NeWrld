import type pkg from 'pg';
import { CanonRepositoryPort } from '../../domain/ports/canon.repository.port.js';
import { CanonSnapshot } from '../../domain/entities/canon-snapshot.entity.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { SnapshotId } from '../../domain/value-objects/snapshot-id.value-object.js';
import { CanonDataSchema } from '../../domain/value-objects/canon-data.schema.js';
import { CorruptCanonSnapshotError } from '../../domain/errors/world.errors.js';
import { query } from '../../../../shared/database/db.js';

/**
 * Namespace for the per-world publish advisory lock. The lock key is
 * derived as `hashtextextended('<namespace>' || world_id, 0)` — a
 * deterministic 64-bit key. Distinct features must use distinct namespaces;
 * never reuse this constant for another lock purpose.
 */
export const PUBLISH_ADVISORY_LOCK_NAMESPACE = 'renewrld:publish:';

/** Bound on advisory-lock acquisition inside a publish transaction. */
export const PUBLISH_LOCK_TIMEOUT = '10s';

/**
 * Postgres adapter for published canon snapshots (Task E2a).
 *
 * Append-only: exposes no update or delete operations (application-level
 * convention; migration 005 / E2c adds a database trigger enforcing
 * immutability).
 */
export class PostgresCanonRepository implements CanonRepositoryPort {
  /**
   * Allocates the next version number for a world.
   *
   * When called with a transaction client (the publish flow), it first
   * acquires the per-world publish advisory lock
   * (`pg_advisory_xact_lock` — transaction-scoped, auto-released on
   * COMMIT/ROLLBACK, cannot leak) and only then computes
   * `MAX(version_number) + 1`, so concurrent publishers of the same world
   * serialize into distinct versions. A `SET LOCAL lock_timeout` bounds
   * lock acquisition so a stuck holder fails the waiter fast instead of
   * hanging the request.
   *
   * Without a transaction client no advisory lock is taken and version
   * allocation is not concurrency-safe; callers must pass the publish
   * transaction's client.
   */
  public async nextVersion(worldId: WorldId, tx?: pkg.PoolClient): Promise<number> {
    const worldIdValue = worldId.getValue();
    if (tx) {
      await tx.query(`SET LOCAL lock_timeout = '${PUBLISH_LOCK_TIMEOUT}'`);
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1 || $2, 0))`,
        [PUBLISH_ADVISORY_LOCK_NAMESPACE, worldIdValue]
      );
    }
    const selectSql =
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
       FROM published_canon_snapshots WHERE world_id = $1`;
    const selectParams = [worldIdValue];
    const result = tx
      ? await tx.query(selectSql, selectParams)
      : await query(selectSql, selectParams);
    return Number(result.rows[0].next_version);
  }

  /**
   * Persists a snapshot. Refuses to write canon data that violates the
   * authoritative `CanonDataSchema` v1 contract — a serialization failure
   * here is a server-side invariant violation (mapped to 500 by the
   * central error handler), never a client error.
   */
  public async insert(snapshot: CanonSnapshot, tx?: pkg.PoolClient): Promise<void> {
    const parsed = CanonDataSchema.safeParse(snapshot.getCanonData());
    if (!parsed.success) {
      throw new Error('Refusing to persist canon snapshot with invalid canon_data');
    }
    const insertSql =
      `INSERT INTO published_canon_snapshots (snapshot_id, world_id, version_number, canon_data)
       VALUES ($1, $2, $3, $4::jsonb)`;
    const insertParams = [
      snapshot.getSnapshotId().getValue(),
      snapshot.getWorldId().getValue(),
      snapshot.getVersionNumber(),
      JSON.stringify(parsed.data),
    ];
    if (tx) {
      await tx.query(insertSql, insertParams);
    } else {
      await query(insertSql, insertParams);
    }
  }

  /**
   * Reads the latest published snapshot for a world (Task F1b, ADR-014 D1).
   *
   * Selects the highest `version_number` — never inferred from the mutable
   * `worlds.status`. Returns `null` only when no snapshot exists. A latest
   * snapshot that fails `CanonDataSchema` validation throws
   * `CorruptCanonSnapshotError`; there is no silent fallback to an older
   * version.
   */
  public async findLatestByWorldId(worldId: WorldId): Promise<CanonSnapshot | null> {
    const result = await query(
      `SELECT snapshot_id, world_id, version_number, canon_data
       FROM published_canon_snapshots
       WHERE world_id = $1
       ORDER BY version_number DESC
       LIMIT 1`,
      [worldId.getValue()]
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0] as {
      snapshot_id: string;
      world_id: string;
      version_number: number;
      canon_data: unknown;
    };
    const parsed = CanonDataSchema.safeParse(row.canon_data);
    if (!parsed.success) {
      throw new CorruptCanonSnapshotError(worldId.getValue());
    }
    return CanonSnapshot.create({
      snapshotId: new SnapshotId(row.snapshot_id),
      worldId: new WorldId(row.world_id),
      versionNumber: Number(row.version_number),
      canonData: parsed.data,
    });
  }
}
