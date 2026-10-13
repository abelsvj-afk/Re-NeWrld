import { describe, it, expect } from 'vitest';
import { validateWorldGraph, validateChoiceReferences } from '../../src/modules/world/domain/services/graph-validator.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { Scene } from '../../src/modules/world/domain/entities/scene.entity.js';
import { Choice } from '../../src/modules/world/domain/entities/choice.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';
import { ChapterId } from '../../src/modules/world/domain/value-objects/chapter-id.value-object.js';
import { ChoiceId } from '../../src/modules/world/domain/value-objects/choice-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';

// Deterministic valid UUIDv4 fixtures.
const W = '123e4567-e89b-42d3-a456-426614174000';
const U = '987fcdeb-5022-42d3-a456-426614174001';
const C = '11111111-2222-4233-8444-555555555555';
const S = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function makeWorld(startScene: string | null): World {
  const world = World.create({
    worldId: new WorldId(W),
    creatorId: new UserId(U),
    title: 'Test World',
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

describe('E1a: graph reachability validator', () => {
  it('linear chain: all reachable, ending reachable, no errors', () => {
    const scenes = [makeScene(1), makeScene(2), makeScene(3, true)];
    const choices = [makeChoice(1, 2), makeChoice(2, 3)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.errors).toEqual([]);
    expect(result.reachable).toEqual([S(1), S(2), S(3)]);
    expect(result.unreachable).toEqual([]);
    expect(result.reachableEndings).toEqual([S(3)]);
  });

  it('branching: visits every branch', () => {
    const scenes = [makeScene(1), makeScene(2), makeScene(3), makeScene(4, true)];
    const choices = [makeChoice(1, 2), makeChoice(1, 3), makeChoice(2, 4), makeChoice(3, 4)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.errors).toEqual([]);
    expect(result.reachable).toEqual([S(1), S(2), S(3), S(4)]);
    expect(result.unreachable).toEqual([]);
    expect(result.reachableEndings).toEqual([S(4)]);
  });

  it('diamond merge: each scene visited exactly once', () => {
    const scenes = [makeScene(1), makeScene(2), makeScene(3), makeScene(4, true)];
    const choices = [makeChoice(1, 2), makeChoice(1, 3), makeChoice(2, 4), makeChoice(3, 4)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.reachable).toHaveLength(4);
    expect(new Set(result.reachable).size).toBe(4);
  });

  it('cycle: terminates and marks the whole cycle reachable', () => {
    const scenes = [makeScene(1), makeScene(2), makeScene(3, true)];
    const choices = [makeChoice(1, 2), makeChoice(2, 1), makeChoice(2, 3), makeChoice(3, 2)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.errors).toEqual([]);
    expect(result.reachable).toEqual(expect.arrayContaining([S(1), S(2), S(3)]));
    expect(result.reachable).toHaveLength(3);
  });

  it('self-loop: terminates', () => {
    const scenes = [makeScene(1, true)];
    const choices = [makeChoice(1, 1)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.errors).toEqual([]);
    expect(result.reachable).toEqual([S(1)]);
    expect(result.reachableEndings).toEqual([S(1)]);
  });

  it('disconnected subgraph: unreachable scenes are warnings, not errors', () => {
    const scenes = [makeScene(1), makeScene(2, true), makeScene(3), makeScene(4)];
    const choices = [makeChoice(1, 2), makeChoice(3, 4)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.errors).toEqual([]);
    expect(result.reachable).toEqual([S(1), S(2)]);
    expect(result.unreachable).toEqual([S(3), S(4)]);
    expect(result.reachableEndings).toEqual([S(2)]);
  });

  it('no endings at all: NO_REACHABLE_ENDING blocker', () => {
    const scenes = [makeScene(1), makeScene(2)];
    const choices = [makeChoice(1, 2)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.reachable).toEqual([S(1), S(2)]);
    expect(result.reachableEndings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('NO_REACHABLE_ENDING');
  });

  it('ending exists but is unreachable: NO_REACHABLE_ENDING blocker', () => {
    const scenes = [makeScene(1), makeScene(2), makeScene(3, true)];
    const choices = [makeChoice(1, 2)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.unreachable).toEqual([S(3)]);
    expect(result.reachableEndings).toEqual([]);
    expect(result.errors.map((e) => e.code)).toEqual(['NO_REACHABLE_ENDING']);
  });

  it('empty world: NO_SCENES blocker', () => {
    const result = validateWorldGraph(makeWorld(null), [], []);

    expect(result.reachable).toEqual([]);
    expect(result.unreachable).toEqual([]);
    expect(result.reachableEndings).toEqual([]);
    expect(result.errors.map((e) => e.code)).toEqual(['NO_SCENES']);
  });

  it('missing start scene: START_SCENE_MISSING blocker; all scenes unreachable', () => {
    const scenes = [makeScene(1), makeScene(2, true)];
    const choices = [makeChoice(1, 2)];

    const result = validateWorldGraph(makeWorld(null), scenes, choices);

    expect(result.reachable).toEqual([]);
    expect(result.unreachable).toEqual([S(1), S(2)]);
    expect(result.errors.map((e) => e.code)).toEqual(['START_SCENE_MISSING']);
  });

  it('start scene not among scenes (malformed): START_SCENE_NOT_FOUND blocker', () => {
    const scenes = [makeScene(1), makeScene(2, true)];
    const choices = [makeChoice(1, 2)];

    const result = validateWorldGraph(makeWorld(S(9)), scenes, choices);

    expect(result.reachable).toEqual([]);
    expect(result.errors.map((e) => e.code)).toEqual(['START_SCENE_NOT_FOUND']);
  });

  it('dangling choice target: skipped during traversal (E1b territory), no crash', () => {
    const scenes = [makeScene(1), makeScene(2, true)];
    const world = makeWorld(S(1));
    // Choice 1->2 valid; choice 2->9 dangles (scene 9 not provided).
    const dangling = Choice.create({
      choiceId: new ChoiceId('aaaaaaaa-bbbb-4ccc-8ddd-000000000099'),
      worldId: new WorldId(W),
      sceneId: new SceneId(S(2)),
      targetSceneId: new SceneId(S(9)),
      text: 'Dangle',
    });

    const result = validateWorldGraph(world, scenes, [makeChoice(1, 2), dangling]);

    expect(result.errors).toEqual([]);
    expect(result.reachable).toEqual([S(1), S(2)]);
  });

  it('is deterministic for a given input order', () => {
    const scenes = [makeScene(1), makeScene(2), makeScene(3, true), makeScene(4)];
    const choices = [makeChoice(1, 3), makeChoice(1, 2), makeChoice(3, 4)];

    const a = validateWorldGraph(makeWorld(S(1)), scenes, choices);
    const b = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(a).toEqual(b);
  });

  it('multiple reachable endings are all reported', () => {
    const scenes = [makeScene(1), makeScene(2, true), makeScene(3, true)];
    const choices = [makeChoice(1, 2), makeChoice(1, 3)];

    const result = validateWorldGraph(makeWorld(S(1)), scenes, choices);

    expect(result.errors).toEqual([]);
    expect(result.reachableEndings).toEqual([S(2), S(3)]);
  });

  it('pure: does not mutate its inputs', () => {
    const world = makeWorld(S(1));
    const scenes = [makeScene(1), makeScene(2, true)];
    const choices = [makeChoice(1, 2)];
    const before = JSON.stringify({
      start: world.getStartSceneId()?.getValue() ?? null,
      scenes: scenes.map((s) => [s.getSceneId().getValue(), s.getIsEnding()]),
    });

    validateWorldGraph(world, scenes, choices);

    const after = JSON.stringify({
      start: world.getStartSceneId()?.getValue() ?? null,
      scenes: scenes.map((s) => [s.getSceneId().getValue(), s.getIsEnding()]),
    });
    expect(after).toBe(before);
  });
});

describe('E1b: structural choice-reference validation', () => {
  it('valid references: no dangling entries', () => {
    const scenes = [makeScene(1), makeScene(2, true)];
    const choices = [makeChoice(1, 2)];

    const result = validateChoiceReferences(scenes, choices);

    expect(result.dangling).toEqual([]);
  });

  it('single dangling target: reported with choice and scene identification', () => {
    const scenes = [makeScene(1)];
    const choices = [makeChoice(1, 2)];

    const result = validateChoiceReferences(scenes, choices);

    expect(result.dangling).toHaveLength(1);
    const [entry] = result.dangling;
    expect(entry.code).toBe('DANGLING_TARGET');
    expect(entry.targetSceneId).toBe(S(2));
    expect(entry.sceneId).toBe(S(1));
    expect(typeof entry.choiceId).toBe('string');
    expect(entry.choiceId.length).toBeGreaterThan(0);
    expect(entry.message).toContain(S(2));
  });

  it('multiple dangling targets: all reported in input order, not just the first', () => {
    const scenes = [makeScene(1)];
    const choices = [makeChoice(1, 2), makeChoice(1, 3), makeChoice(1, 4)];

    const result = validateChoiceReferences(scenes, choices);

    expect(result.dangling).toHaveLength(3);
    expect(result.dangling.map((d) => d.targetSceneId)).toEqual([S(2), S(3), S(4)]);
    expect(result.dangling.map((d) => d.code)).toEqual([
      'DANGLING_TARGET',
      'DANGLING_TARGET',
      'DANGLING_TARGET',
    ]);
  });

  it('mixed valid and dangling: only the dangling ones are reported', () => {
    const scenes = [makeScene(1), makeScene(2, true)];
    const choices = [makeChoice(1, 2), makeChoice(2, 9)];

    const result = validateChoiceReferences(scenes, choices);

    expect(result.dangling).toHaveLength(1);
    expect(result.dangling[0].targetSceneId).toBe(S(9));
    expect(result.dangling[0].sceneId).toBe(S(2));
  });

  it('valid self-loop: not dangling', () => {
    const scenes = [makeScene(1, true)];
    const choices = [makeChoice(1, 1)];

    const result = validateChoiceReferences(scenes, choices);

    expect(result.dangling).toEqual([]);
  });

  it('empty choices: no dangling entries', () => {
    const result = validateChoiceReferences([makeScene(1)], []);

    expect(result.dangling).toEqual([]);
  });

  it('empty scenes: every choice target dangles', () => {
    const choices = [makeChoice(1, 2), makeChoice(2, 3)];

    const result = validateChoiceReferences([], choices);

    expect(result.dangling).toHaveLength(2);
  });

  it('does not mutate its inputs', () => {
    const scenes = [makeScene(1)];
    const choices = [makeChoice(1, 2)];
    const before = JSON.stringify(choices.map((c) => c.getTargetSceneId().getValue()));

    validateChoiceReferences(scenes, choices);

    expect(JSON.stringify(choices.map((c) => c.getTargetSceneId().getValue()))).toBe(before);
  });

  it('E1a behavior preserved: reachability still treats dangling targets as out of scope', () => {
    const scenes = [makeScene(1), makeScene(2, true)];
    const world = makeWorld(S(1));
    const dangling = Choice.create({
      choiceId: new ChoiceId('aaaaaaaa-bbbb-4ccc-8ddd-000000000099'),
      worldId: new WorldId(W),
      sceneId: new SceneId(S(2)),
      targetSceneId: new SceneId(S(9)),
      text: 'Dangle',
    });

    const graph = validateWorldGraph(world, scenes, [makeChoice(1, 2), dangling]);
    const refs = validateChoiceReferences(scenes, [makeChoice(1, 2), dangling]);

    expect(graph.errors).toEqual([]);
    expect(refs.dangling).toHaveLength(1);
    expect(refs.dangling[0].code).toBe('DANGLING_TARGET');
  });
});
