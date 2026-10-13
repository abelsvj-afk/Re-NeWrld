import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type pkg from 'pg';
import { StartReaderSessionUseCase } from '../../src/modules/session/application/start-reader-session.use-case.js';
import { ReaderSession } from '../../src/modules/session/domain/entities/reader-session.entity.js';
import { SessionId } from '../../src/modules/session/domain/value-objects/session-id.value-object.js';
import { SessionRepositoryPort } from '../../src/modules/session/domain/ports/session.repository.port.js';
import {
  NoPublishedSnapshotError,
} from '../../src/modules/session/domain/errors/session.errors.js';
import {
  WorldNotFoundError,
  CorruptCanonSnapshotError,
} from '../../src/modules/world/domain/errors/world.errors.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { WorldRepositoryPort } from '../../src/modules/world/domain/ports/world.repository.port.js';
import { CanonSnapshot } from '../../src/modules/world/domain/entities/canon-snapshot.entity.js';
import { SnapshotId } from '../../src/modules/world/domain/value-objects/snapshot-id.value-object.js';
import { CanonRepositoryPort } from '../../src/modules/world/domain/ports/canon.repository.port.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';

function makeWorld(worldId: WorldId, creatorId: UserId): World {
  return World.create({ worldId, creatorId, title: 'W', description: null, metadata: {} });
}

function makeSnapshot(worldId: WorldId, version: number, startSceneId: string): CanonSnapshot {
  return CanonSnapshot.create({
    snapshotId: SnapshotId.generate(),
    worldId,
    versionNumber: version,
    canonData: {
      canon_schema_version: 1,
      world: {
        world_id: worldId.getValue(),
        title: 'W',
        description: null,
        metadata: {},
        start_scene_id: startSceneId,
      },
      scenes: [],
      choices: [],
    },
  });
}

class FakeWorldRepository implements WorldRepositoryPort {
  constructor(private readonly worlds: World[] = []) {}
  async findById(worldId: WorldId): Promise<World | null> {
    return this.worlds.find((w) => w.getWorldId().equals(worldId)) ?? null;
  }
  async findByCreatorId(): Promise<World[]> {
    return [];
  }
  async save(): Promise<void> {}
  async delete(): Promise<void> {}
}

class FakeCanonRepository implements CanonRepositoryPort {
  public snapshots: CanonSnapshot[] = [];
  public throwCorrupt = false;
  async nextVersion(): Promise<number> {
    return this.snapshots.length + 1;
  }
  async insert(snapshot: CanonSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }
  async findLatestByWorldId(worldId: WorldId): Promise<CanonSnapshot | null> {
    if (this.throwCorrupt) {
      throw new CorruptCanonSnapshotError(worldId.getValue());
    }
    const matching = this.snapshots.filter((s) => s.getWorldId().equals(worldId));
    if (matching.length === 0) {
      return null;
    }
    // Mirrors the SQL contract: highest version_number wins.
    return matching.reduce((a, b) => (a.getVersionNumber() >= b.getVersionNumber() ? a : b));
  }
}

class FakeSessionRepository implements SessionRepositoryPort {
  public sessions: ReaderSession[] = [];
  async findById(sessionId: SessionId): Promise<ReaderSession | null> {
    return this.sessions.find((s) => s.getSessionId().equals(sessionId)) ?? null;
  }
  async findByReaderId(readerId: UserId): Promise<ReaderSession[]> {
    return this.sessions.filter((s) => s.getReaderId().equals(readerId));
  }
  async save(session: ReaderSession, _tx?: pkg.PoolClient): Promise<void> {
    this.sessions.push(session);
  }
}

describe('StartReaderSessionUseCase (F1b)', () => {
  let worlds: FakeWorldRepository;
  let canon: FakeCanonRepository;
  let sessions: FakeSessionRepository;
  let useCase: StartReaderSessionUseCase;
  let worldId: WorldId;
  let readerId: UserId;

  beforeEach(() => {
    worldId = new WorldId(crypto.randomUUID());
    readerId = new UserId(crypto.randomUUID());
    worlds = new FakeWorldRepository([makeWorld(worldId, new UserId(crypto.randomUUID()))]);
    canon = new FakeCanonRepository();
    sessions = new FakeSessionRepository();
    useCase = new StartReaderSessionUseCase(worlds, canon, sessions);
  });

  it('pins the session to the latest snapshot and its canon start scene', async () => {
    const startV1 = crypto.randomUUID();
    const startV2 = crypto.randomUUID();
    canon.snapshots = [makeSnapshot(worldId, 1, startV1), makeSnapshot(worldId, 2, startV2)];

    const { session } = await useCase.execute({ worldId, readerId });

    // Highest version selected — never an older snapshot.
    expect(session.getSnapshotId().equals(canon.snapshots[1].getSnapshotId())).toBe(true);
    expect(session.getCurrentSceneId().getValue()).toBe(startV2);
    expect(session.getWorldId().equals(worldId)).toBe(true);
    expect(session.getReaderId().equals(readerId)).toBe(true);
    expect(session.getStateVariables()).toEqual({});
    expect(session.getVersion()).toBe(1);
    expect(session.getStatus().getValue()).toBe('active');
    expect(sessions.sessions).toHaveLength(1);
  });

  it('throws 409 when the world has no published snapshot; saves nothing', async () => {
    const err = await useCase.execute({ worldId, readerId }).catch((e) => e);
    expect(err).toBeInstanceOf(NoPublishedSnapshotError);
    expect(err.statusCode).toBe(409);
    expect(sessions.sessions).toHaveLength(0);
  });

  it('propagates corrupt latest snapshot as 500; never falls back silently', async () => {
    canon.throwCorrupt = true;
    const err = await useCase.execute({ worldId, readerId }).catch((e) => e);
    expect(err).toBeInstanceOf(CorruptCanonSnapshotError);
    expect(err.statusCode).toBe(500);
    expect(sessions.sessions).toHaveLength(0);
  });

  it('throws 404 for an unknown world', async () => {
    const err = await useCase
      .execute({ worldId: new WorldId(crypto.randomUUID()), readerId })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WorldNotFoundError);
    expect(err.statusCode).toBe(404);
  });

  it('derives the owner exclusively from the command readerId', async () => {
    canon.snapshots = [makeSnapshot(worldId, 1, crypto.randomUUID())];
    const otherReader = new UserId(crypto.randomUUID());
    const { session } = await useCase.execute({ worldId, readerId });
    expect(session.getReaderId().equals(readerId)).toBe(true);
    expect(session.getReaderId().equals(otherReader)).toBe(false);
  });

  it('concurrent initializations create independent sessions', async () => {
    canon.snapshots = [makeSnapshot(worldId, 1, crypto.randomUUID())];
    const [r1, r2] = await Promise.all([
      useCase.execute({ worldId, readerId }),
      useCase.execute({ worldId, readerId }),
    ]);
    expect(r1.session.getSessionId().equals(r2.session.getSessionId())).toBe(false);
    expect(sessions.sessions).toHaveLength(2);
    // Both pin to the same immutable snapshot.
    expect(r1.session.getSnapshotId().equals(r2.session.getSnapshotId())).toBe(true);
  });
});
