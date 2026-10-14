import { describe, it, expect } from 'vitest';
import { validateChoiceSemanticsForPublish } from '../../src/modules/world/domain/services/graph-validator.js';
import { Choice } from '../../src/modules/world/domain/entities/choice.entity.js';
import { ChoiceId } from '../../src/modules/world/domain/value-objects/choice-id.value-object.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../src/modules/world/domain/value-objects/scene-id.value-object.js';

const W = '123e4567-e89b-42d3-a456-426614174000';
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';

let n = 0;
function makeChoice(conditions?: unknown, mutations?: unknown): Choice {
  n += 1;
  return Choice.create({
    choiceId: new ChoiceId(`aaaaaaaa-bbbb-4ccc-8ddd-0000000000${String(n).padStart(2, '0')}`),
    worldId: new WorldId(W),
    sceneId: new SceneId(S1),
    targetSceneId: new SceneId(S2),
    text: `Choice ${n}`,
    conditions: conditions as never,
    mutations: mutations as never,
  });
}

describe('G1c: publish-time semantic validation', () => {
  it('valid grammar passes with no blockers', () => {
    const choices = [
      makeChoice(
        { op: 'and', conditions: [{ op: 'has', var: 'sword' }] },
        [{ op: 'inc', var: 'gold', by: 5 }]
      ),
    ];
    expect(validateChoiceSemanticsForPublish(choices).blockers).toEqual([]);
  });
  it('absent conditions/mutations pass (unconditional)', () => {
    expect(validateChoiceSemanticsForPublish([makeChoice()]).blockers).toEqual([]);
  });
  it('legacy {} conditions are a blocker', () => {
    const { blockers } = validateChoiceSemanticsForPublish([makeChoice({}, undefined)]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe('EMPTY_CONDITION_OBJECT');
    expect(blockers[0].choiceId).toBeDefined();
    expect(blockers[0].sceneId).toBe(S1);
  });
  it('unknown operators and malformed mutations are blockers', () => {
    const { blockers } = validateChoiceSemanticsForPublish([
      makeChoice({ op: 'xor', var: 'x' }, [{ op: 'multiply', var: 'gold', by: 2 }]),
    ]);
    expect(blockers.map((b) => b.code).sort()).toEqual([
      'INVALID_CONDITION',
      'INVALID_MUTATION',
    ]);
  });
  it('reports all offending choices, in order', () => {
    const { blockers } = validateChoiceSemanticsForPublish([
      makeChoice(),
      makeChoice({ op: 'bogus' }),
      makeChoice({ op: 'has', var: '__proto__' }),
    ]);
    expect(blockers).toHaveLength(2);
    expect(blockers[0].choiceId).not.toBe(blockers[1].choiceId);
  });
  it('does not mutate the choices', () => {
    const c = makeChoice({ op: 'has', var: 'x' }, []);
    validateChoiceSemanticsForPublish([c]);
    expect(c.getConditions()).toEqual({ op: 'has', var: 'x' });
  });
});
