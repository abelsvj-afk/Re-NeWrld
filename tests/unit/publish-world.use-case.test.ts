import { describe, it, expect, vi, beforeEach } from 'vitest';

// Faithful fake of db.js's withTransaction contract: BEGIN → fn → COMMIT,
// on failure records the rollback path and rethrows the original error.
const txCalls: string[] = [];
vi.mock('../../src/shared/database/db.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    txCalls.push('begin');
    const tx = { query: vi.fn(async () => ({ rows: [] })) };
    try {
      const result = await fn(tx);
      txCalls.push('commit');
      return result;
    } catch (err) {
      txCalls.push('rollback');
      throw err;
    }
  }),
}));

import { PublishWorldUseCase, buildCanonData } from '../../src/modules/world/application/publish-world.use-case.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { Scene } from '../../src/modules/world/domain/entities/scene.entity.js';
import { Choice } from '../../src/modules/world/domain/entities/choice.entity.js';
import { CanonSnapshot } from '../../src/modules/world/domain/entities/canon-snapshot.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { ChapterId } from '../../src/modules/world/domain/value-objects/chapter-id.value-object.js';
import { ChoiceId } from '../../src/modules/world/domain/value-objects/choice-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { WorldRepositoryPort } from '../../src/modules/world/domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from '../../src/modules/world/domain/ports/scene.repository.port.js';
import { ChoiceRepositoryPort } from '../../src/modules/world/domain/ports/choice.repository.port.js';
import { CanonRepositoryPort } from '../../src/modules/world/domain/ports/canon.repository.port.js';
import {
  WorldNotFoundError,
  PublishingValidationError,
} from '../../src/modules/world/domain/errors/world.errors.js';

const W = '123e4567-e89b-42d3-a456-426614174000';
const U = '987fcdeb-5022-42d3-a456-426614174001';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-999999999999';
const C = '11111111-2222-4233-8444-555555555555';
const S = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function makeWorld(startScene: string | null, creator = U): World {
  const world = World.create({
    worldId: new WorldId(W),
    creatorId: new UserId(creator),
    title: 'Test World',
    description: 'A test world',
  });
  world.setStartSceneId(startScene ? new SceneId(startScene) : null);
  return world;
}

function makeScene(n: number, isEnding = false): Scene {
  return Scene.create({
    sceneId: new SceneId(S(n)),
    worldId: new WorldId(W),
    chapterId: new ChapterId(C),
    title: `Scene ${n}`,
    prose: 'prose',
    isEnding,
  });
}

let choiceCounter = 0;
function makeChoice(from: number, to: number): Choice {
  choiceCounter += 1;
  return Choice.create({
    choiceId: new ChoiceId(`aaaaaaaa-bbbb-4ccc-8ddd-0000000000${String(choiceCounter).padStart(2, '0')}`),
    worldId: new WorldId(W),
    sceneId: new SceneId(S(from)),
    targetSceneId: new SceneId(S(to)),
    text: `Go ${from} -> ${to}`,
  });
}

function validGraph() {
  return {
    scenes: [makeScene(1), makeScene(2, true)],
    choices: [makeChoice(1, 2)],
  };
}

class FakeWorldRepo implements WorldRepositoryPort {
  public saved: World[] = [];
  constructor(private world: World | null) {}
  async findById(): Promise<World | null> {
    return this.world;
  }
  async findByCreatorId(): Promise<World[]> {
    return this.world ? [this.world] : [];
  }
  async save(world: World): Promise<void> {
    this.saved.push(world);
  }
  async delete(): Promise<void> {}
}

class FakeSceneRepo implements SceneRepositoryPort {
  constructor(private scenes: Scene[]) {}
  async findByWorldId(): Promise<Scene[]> {
    return this.scenes;
  }
}

class FakeChoiceRepo implements ChoiceRepositoryPort {
  constructor(private choices: Choice[]) {}
  async findByWorldId(): Promise<Choice[]> {
    return this.choices;
  }
}

class FakeCanonRepo implements CanonRepositoryPort {
  public snapshots: CanonSnapshot[] = [];
  public failOnInsert = false;
  async nextVersion(): Promise<number> {
    const max = this.snapshots.reduce((m, s) => Math.max(m, s.getVersionNumber()), 0);
    return max + 1;
  }
  async insert(snapshot: CanonSnapshot): Promise<void> {
    if (this.failOnInsert) {
      throw new Error('boom: insert failed');
    }
    this.snapshots.push(snapshot);
  }
}

describe('E2a: PublishWorldUseCase', () => {
  let worlds: FakeWorldRepo;
  let scenes: FakeSceneRepo;
  let choices: FakeChoiceRepo;
  let canon: FakeCanonRepo;
  let useCase: PublishWorldUseCase;

  beforeEach(() => {
    vi.clearAllMocks();
    txCalls.length = 0;
    choiceCounter = 0;
    const g = validGraph();
    worlds = new FakeWorldRepo(makeWorld(S(1)));
    scenes = new FakeSceneRepo(g.scenes);
    choices = new FakeChoiceRepo(g.choices);
    canon = new FakeCanonRepo();
    useCase = new PublishWorldUseCase(worlds, scenes, choices, canon);
  });

  it('publishes a valid world: snapshot v1, world flipped to published', async () => {
    const result = await useCase.execute({
      worldId: new WorldId(W),
      creatorId: new UserId(U),
    });

    expect(result.snapshot.getVersionNumber()).toBe(1);
    expect(result.snapshot.getWorldId().getValue()).toBe(W);
    expect(result.warnings).toEqual([]);
    expect(worlds.saved).toHaveLength(1);
    expect(worlds.saved[0].getStatus().getValue()).toBe('published');
    expect(txCalls).toEqual(['begin', 'commit']);
  });

  it('blocker abort: zero writes and no transaction on validation failure', async () => {
    worlds = new FakeWorldRepo(makeWorld(null)); // no start scene
    useCase = new PublishWorldUseCase(worlds, scenes, choices, canon);

    const err = await useCase
      .execute({ worldId: new WorldId(W), creatorId: new UserId(U) })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PublishingValidationError);
    expect(err.statusCode).toBe(422);
    expect(err.report.blockers.length).toBeGreaterThan(0);
    expect(canon.snapshots).toHaveLength(0);
    expect(worlds.saved).toHaveLength(0);
    expect(txCalls).toEqual([]);
  });

  it('dangling target is a 422 blocker with zero writes', async () => {
    const g = validGraph();
    choices = new FakeChoiceRepo([...g.choices, makeChoice(2, 9)]);
    useCase = new PublishWorldUseCase(worlds, scenes, choices, canon);

    const err = await useCase
      .execute({ worldId: new WorldId(W), creatorId: new UserId(U) })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PublishingValidationError);
    expect(err.statusCode).toBe(422);
    expect(err.report.blockers.map((b: any) => b.code)).toContain('DANGLING_TARGET');
    expect(canon.snapshots).toHaveLength(0);
    expect(worlds.saved).toHaveLength(0);
  });

  it('warnings preserved: unreachable scenes do not block publication', async () => {
    scenes = new FakeSceneRepo([makeScene(1), makeScene(2, true), makeScene(3)]);
    useCase = new PublishWorldUseCase(worlds, scenes, choices, canon);

    const result = await useCase.execute({
      worldId: new WorldId(W),
      creatorId: new UserId(U),
    });

    expect(result.warnings).toEqual([S(3)]);
    expect(result.snapshot.getVersionNumber()).toBe(1);
  });

  it('version increments: second publish creates v2', async () => {
    await useCase.execute({ worldId: new WorldId(W), creatorId: new UserId(U) });
    const second = await useCase.execute({
      worldId: new WorldId(W),
      creatorId: new UserId(U),
    });

    expect(canon.snapshots).toHaveLength(2);
    expect(canon.snapshots[0].getVersionNumber()).toBe(1);
    expect(second.snapshot.getVersionNumber()).toBe(2);
    // Structural equality: earlier snapshot unchanged by the second publish.
    expect(JSON.parse(JSON.stringify(canon.snapshots[0].getCanonData()))).toEqual(
      JSON.parse(JSON.stringify(canon.snapshots[0].getCanonData()))
    );
  });

  it('already-published world can re-publish without revertToDraft', async () => {
    const world = makeWorld(S(1));
    world.publish();
    worlds = new FakeWorldRepo(world);
    useCase = new PublishWorldUseCase(worlds, scenes, choices, canon);

    const result = await useCase.execute({
      worldId: new WorldId(W),
      creatorId: new UserId(U),
    });

    expect(result.snapshot.getVersionNumber()).toBe(1);
    expect(worlds.saved[0].getStatus().getValue()).toBe('published');
  });

  it('404-not-403: wrong creator cannot publish', async () => {
    const err = await useCase
      .execute({ worldId: new WorldId(W), creatorId: new UserId(OTHER) })
      .catch((e) => e);

    expect(err).toBeInstanceOf(WorldNotFoundError);
    expect(err.statusCode).toBe(404);
    expect(canon.snapshots).toHaveLength(0);
  });

  it('world not found: 404 with zero writes', async () => {
    worlds = new FakeWorldRepo(null);
    useCase = new PublishWorldUseCase(worlds, scenes, choices, canon);

    const err = await useCase
      .execute({ worldId: new WorldId(W), creatorId: new UserId(U) })
      .catch((e) => e);

    expect(err).toBeInstanceOf(WorldNotFoundError);
    expect(canon.snapshots).toHaveLength(0);
    expect(txCalls).toEqual([]);
  });

  it('transaction rollback: original error preserved, world save never reached', async () => {
    canon.failOnInsert = true;

    const err = await useCase
      .execute({ worldId: new WorldId(W), creatorId: new UserId(U) })
      .catch((e) => e);

    expect(err.message).toBe('boom: insert failed');
    expect(txCalls).toEqual(['begin', 'rollback']);
    expect(worlds.saved).toHaveLength(0);
    expect(canon.snapshots).toHaveLength(0);
  });

  it('canon_data matches the v1 contract exactly (field pinning)', async () => {
    const g = validGraph();
    const world = makeWorld(S(1));
    const localUseCase = new PublishWorldUseCase(
      new FakeWorldRepo(world),
      new FakeSceneRepo(g.scenes),
      new FakeChoiceRepo(g.choices),
      canon
    );
    const result = await localUseCase.execute({
      worldId: new WorldId(W),
      creatorId: new UserId(U),
    });
    const canonData = JSON.parse(JSON.stringify(result.snapshot.getCanonData()));

    expect(Object.keys(canonData).sort()).toEqual([
      'canon_schema_version',
      'choices',
      'condition_grammar_version',
      'scenes',
      'world',
    ]);
    expect(canonData.canon_schema_version).toBe(1);
    // G1: newly published canon is marked v1 (G1c validated the grammar).
    expect(canonData.condition_grammar_version).toBe(1);
    expect(Object.keys(canonData.world).sort()).toEqual([
      'description',
      'metadata',
      'start_scene_id',
      'title',
      'world_id',
    ]);
    expect(canonData.world.start_scene_id).toBe(S(1));
    expect(Object.keys(canonData.scenes[0]).sort()).toEqual([
      'chapter_id',
      'is_ending',
      'metadata',
      'prose',
      'scene_id',
      'title',
    ]);
    // G1: conditions/mutations are ABSENT when not set (unconditional choice).
    expect(Object.keys(canonData.choices[0]).sort()).toEqual([
      'choice_id',
      'scene_id',
      'sort_order',
      'target_scene_id',
      'text',
    ]);
    // Structural deep-equality against the builder output (JSONB semantics).
    expect(canonData).toEqual(JSON.parse(JSON.stringify(buildCanonData(world, g.scenes, g.choices))));
  });
});
