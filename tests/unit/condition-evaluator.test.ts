import { describe, it, expect } from 'vitest';
import {
  evaluateCondition,
  deepEqual,
} from '../../src/modules/session/domain/services/condition-evaluator.js';
import type { Condition } from '../../src/modules/world/domain/services/grammar.schema.js';

const S = {
  gold: 10,
  name: 'Ari',
  sword: true,
  broken: false,
  empty: null,
  align: 'good',
  tags: ['a', 'b'],
  nested: { x: 1, y: [2] },
};

describe('deepEqual', () => {
  it('compares primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });
  it('ignores object key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
  it('compares arrays and nesting', () => {
    expect(deepEqual([1, [2]], [1, [2]])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ x: [1] }, { x: [1] })).toBe(true);
    // Mixed array/object and null/object are unequal, never throw.
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });
});

describe('evaluateCondition truth tables', () => {
  it('and/or/not', () => {
    const t: Condition = { op: 'has', var: 'sword' };
    const f: Condition = { op: 'has', var: 'nope' };
    expect(evaluateCondition({ op: 'and', conditions: [t, t] }, S)).toBe(true);
    expect(evaluateCondition({ op: 'and', conditions: [t, f] }, S)).toBe(false);
    expect(evaluateCondition({ op: 'or', conditions: [f, t] }, S)).toBe(true);
    expect(evaluateCondition({ op: 'or', conditions: [f, f] }, S)).toBe(false);
    expect(evaluateCondition({ op: 'not', condition: t }, S)).toBe(false);
    expect(evaluateCondition({ op: 'not', condition: f }, S)).toBe(true);
    expect(
      evaluateCondition({ op: 'and', conditions: [{ op: 'or', conditions: [f, t] }, t] }, S)
    ).toBe(true);
  });
  it('eq/ne with deep equality', () => {
    expect(evaluateCondition({ op: 'eq', var: 'gold', value: 10 }, S)).toBe(true);
    expect(evaluateCondition({ op: 'eq', var: 'gold', value: 11 }, S)).toBe(false);
    expect(evaluateCondition({ op: 'eq', var: 'nested', value: { y: [2], x: 1 } }, S)).toBe(true);
    expect(evaluateCondition({ op: 'ne', var: 'gold', value: 11 }, S)).toBe(true);
    expect(evaluateCondition({ op: 'ne', var: 'gold', value: 10 }, S)).toBe(false);
    // Missing var → false for BOTH eq and ne (never true-by-default).
    expect(evaluateCondition({ op: 'eq', var: 'missing', value: 1 }, S)).toBe(false);
    expect(evaluateCondition({ op: 'ne', var: 'missing', value: 1 }, S)).toBe(false);
  });
  it('numeric comparisons', () => {
    expect(evaluateCondition({ op: 'gt', var: 'gold', value: 9 }, S)).toBe(true);
    expect(evaluateCondition({ op: 'gt', var: 'gold', value: 10 }, S)).toBe(false);
    expect(evaluateCondition({ op: 'gte', var: 'gold', value: 10 }, S)).toBe(true);
    expect(evaluateCondition({ op: 'lt', var: 'gold', value: 11 }, S)).toBe(true);
    expect(evaluateCondition({ op: 'lte', var: 'gold', value: 10 }, S)).toBe(true);
    // Type mismatch → false, never throws.
    expect(evaluateCondition({ op: 'gt', var: 'name', value: 1 }, S)).toBe(false);
    expect(evaluateCondition({ op: 'gt', var: 'missing', value: 1 }, S)).toBe(false);
    expect(evaluateCondition({ op: 'gt', var: 'empty', value: 1 }, S)).toBe(false);
  });
  it('has: key presence including null-valued keys', () => {
    expect(evaluateCondition({ op: 'has', var: 'sword' }, S)).toBe(true);
    expect(evaluateCondition({ op: 'has', var: 'empty' }, S)).toBe(true);
    expect(evaluateCondition({ op: 'has', var: 'missing' }, S)).toBe(false);
  });
  it('in: deep-equality membership', () => {
    expect(
      evaluateCondition({ op: 'in', var: 'align', values: ['good', 'neutral'] }, S)
    ).toBe(true);
    expect(evaluateCondition({ op: 'in', var: 'align', values: ['evil'] }, S)).toBe(false);
    expect(
      evaluateCondition({ op: 'in', var: 'nested', values: [{ x: 1, y: [2] }] }, S)
    ).toBe(true);
    expect(evaluateCondition({ op: 'in', var: 'missing', values: [1] }, S)).toBe(false);
  });
  it('does not mutate the state', () => {
    const before = structuredClone(S);
    evaluateCondition({ op: 'and', conditions: [{ op: 'has', var: 'gold' }] }, S);
    expect(S).toEqual(before);
  });
});
