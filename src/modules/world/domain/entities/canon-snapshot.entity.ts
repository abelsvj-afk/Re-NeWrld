import { SnapshotId } from '../value-objects/snapshot-id.value-object.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { CanonData, CanonDataSchema } from '../value-objects/canon-data.schema.js';

export interface CanonSnapshotProps {
  snapshotId: SnapshotId;
  worldId: WorldId;
  versionNumber: number;
  canonData: CanonData;
  publishedAt?: Date;
}

/**
 * Published canon snapshot (Task E2a).
 *
 * A snapshot is an immutable, versioned copy of a world's draft graph at
 * publish time. Snapshots are append-only: they are never updated or
 * deleted by application code (database trigger in migration 005 / E2c
 * enforces this). `canonData` is validated against the authoritative
 * `CanonDataSchema` v1 contract on creation.
 */
export class CanonSnapshot {
  private readonly snapshotId: SnapshotId;
  private readonly worldId: WorldId;
  private readonly versionNumber: number;
  private readonly canonData: CanonData;
  private readonly publishedAt: Date;

  private constructor(props: CanonSnapshotProps) {
    if (!Number.isInteger(props.versionNumber) || props.versionNumber < 1) {
      throw new Error('CanonSnapshot versionNumber must be a positive integer');
    }
    // Authoritative contract check: never construct a snapshot with
    // canon data that violates the v1 schema.
    const validated = CanonDataSchema.parse(props.canonData);

    this.snapshotId = props.snapshotId;
    this.worldId = props.worldId;
    this.versionNumber = props.versionNumber;
    this.canonData = validated;
    this.publishedAt = props.publishedAt ? new Date(props.publishedAt.getTime()) : new Date();
  }

  public static create(props: CanonSnapshotProps): CanonSnapshot {
    return new CanonSnapshot(props);
  }

  public getSnapshotId(): SnapshotId {
    return this.snapshotId;
  }

  public getWorldId(): WorldId {
    return this.worldId;
  }

  public getVersionNumber(): number {
    return this.versionNumber;
  }

  public getCanonData(): CanonData {
    return this.canonData;
  }

  public getPublishedAt(): Date {
    return new Date(this.publishedAt.getTime());
  }

  public equals(other: CanonSnapshot | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.snapshotId.equals(other.getSnapshotId());
  }
}
