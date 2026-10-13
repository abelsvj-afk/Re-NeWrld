import type pkg from 'pg';
import { CanonSnapshot } from '../entities/canon-snapshot.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';

/**
 * Persistence port for published canon snapshots (Task E2a).
 *
 * Snapshots are append-only: this port exposes no update or delete
 * operations (application-level convention; migration 005 / E2c adds a
 * database trigger enforcing immutability).
 *
 * Concurrency contract: `nextVersion` must be called inside a transaction,
 * after acquiring the per-world publish advisory lock, on the same
 * transaction client that later calls `insert`. The Postgres implementation
 * encapsulates lock acquisition inside `nextVersion`.
 *
 * Readers (Phase F+) must validate `canon_data` against `CanonDataSchema`
 * when reading snapshots, mirroring the write-time validation.
 */
export interface CanonRepositoryPort {
  nextVersion(worldId: WorldId, tx?: pkg.PoolClient): Promise<number>;
  insert(snapshot: CanonSnapshot, tx?: pkg.PoolClient): Promise<void>;
  /**
   * Returns the snapshot with the highest `version_number` for the world, or
   * `null` when the world has never been published. The snapshot table is
   * authoritative — the latest version is never inferred from the mutable
   * `worlds.status` column.
   *
   * `canon_data` is validated against `CanonDataSchema` on read. A corrupt
   * latest snapshot throws `CorruptCanonSnapshotError` (HTTP 500); the
   * implementation never silently falls back to an older version.
   */
  findLatestByWorldId(worldId: WorldId): Promise<CanonSnapshot | null>;
}
