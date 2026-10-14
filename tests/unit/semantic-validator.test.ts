import { describe, it, expect } from 'vitest';
import {
  validateChoiceSemantics,
  parseMutations,
} from '../../src/modules/world/domain/services/semantic-validator.js';

const has = (v: string) => ({ op: 'has', var: v });
const deep = (n: number): unknown => {
  // Build a nested `not` chain n levels deep.
  let c: unknown = has('x');
  for (let i = 0; i < n; i++) c = { op: 'not', condition: c };
  return c;
};
const manyNodes = (n: number) => ({
  op: 'and',
  conditions: Array.from({ length: n }, (_, i) => has(`v${i}`)),
});

describe('validateChoiceSemantics', () => {
  it('accepts absent conditions (unconditional) and absent mutations', () => {
    expect(validateChoiceSemantics(undefined, undefined)).toEqual([]);
  });
  it('accepts empty mutation list', () => {
    expect(validateChoiceSemantics(undefined, [])).toEqual([]);
  });
  it('rejects {} conditions (B4)', () => {
    const v = validateChoiceSemantics({}, undefined);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('EMPTY_CONDITION_OBJECT');
  });
  it('accepts valid conditions and mutations', () => {
    const v = validateChoiceSemantics(
      { op: 'and', conditions: [has('sword'), { op: 'gte', var: 'gold', value: 10 }] },
      [{ op: 'inc', var: 'gold', by: 5 }, { op: 'unset', var: 'temp' }]
    );
    expect(v).toEqual([]);
  });
  it('reports invalid conditions', () => {
    const v = validateChoiceSemantics({ op: 'bogus' }, undefined);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('INVALID_CONDITION');
    expect(v[0].payload).toBe('conditions');
  });
  it('reports invalid mutations', () => {
    const v = validateChoiceSemantics(undefined, [{ op: 'bogus', var: 'x' }]);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('INVALID_MUTATION');
    expect(v[0].payload).toBe('mutations');
  });
  it('reports non-array mutations', () => {
    const v = validateChoiceSemantics(undefined, { op: 'set', var: 'x', value: 1 });
    expect(v.some((x) => x.code === 'INVALID_MUTATION')).toBe(true);
  });
  it('enforces max depth 10', () => {
    expect(validateChoiceSemantics(deep(9), undefined)).toEqual([]);
    const v = validateChoiceSemantics(deep(10), undefined);
    expect(v.some((x) => x.code === 'NESTING_TOO_DEEP')).toBe(true);
  });
  it('enforces max 100 nodes', () => {
    // 99 children + 1 and-node = 100 nodes → OK; 100 children + 1 = 101 → violation.
    expect(validateChoiceSemantics(manyNodes(99), undefined)).toEqual([]);
    const v = validateChoiceSemantics(manyNodes(100), undefined);
    expect(v.some((x) => x.code === 'TOO_MANY_NODES')).toBe(true);
  });
  it('enforces max 50 mutations', () => {
    const ok = Array.from({ length: 50 }, (_, i) => ({ op: 'set', var: `v${i}`, value: 1 }));
    expect(validateChoiceSemantics(undefined, ok)).toEqual([]);
    const tooMany = [...ok, { op: 'set', var: 'extra', value: 1 }];
    const v = validateChoiceSemantics(undefined, tooMany);
    expect(v.some((x) => x.code === 'TOO_MANY_MUTATIONS')).toBe(true);
  });
  it('rejects __proto__ keys (C3)', () => {
    const v = validateChoiceSemantics({ op: 'has', var: '__proto__' }, undefined);
    expect(v.some((x) => x.code === 'INVALID_CONDITION')).toBe(true);
  });
  it('reports multiple violations at once', () => {
    const v = validateChoiceSemantics({ op: 'bogus' }, [{ op: 'nope' }]);
    expect(v).toHaveLength(2);
  });
  it('violation messages include paths', () => {
    const v = validateChoiceSemantics(
      { op: 'and', conditions: [{ op: 'gt', var: 'x', value: 'bad' }] },
      undefined
    );
    expect(v[0].message).toContain('conditions.0.value');
  });
  it('root-level parse failures use (root) path', () => {
    const v = validateChoiceSemantics(null, undefined);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('(root)');
  });
});

describe('parseMutations', () => {
  it('returns [] for undefined (B20)', () => {
    expect(parseMutations(undefined)).toEqual([]);
  });
  it('parses valid lists', () => {
    expect(parseMutations([{ op: 'set', var: 'x', value: 1 }])).toEqual([
      { op: 'set', var: 'x', value: 1 },
    ]);
  });
  it('throws on invalid', () => {
    expect(() => parseMutations([{ op: 'bogus' }])).toThrow();
  });
});
