import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ConditionSchema,
  MutationSchema,
  MutationListSchema,
  GrammarMarkerSchema,
  VarNameSchema,
  JsonValueSchema,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  MAX_MUTATIONS_PER_CHOICE,
} from '../../src/modules/world/domain/services/grammar.schema.js';

describe('VarNameSchema', () => {
  it('accepts normal names', () => {
    expect(VarNameSchema.safeParse('gold').success).toBe(true);
    expect(VarNameSchema.safeParse('a'.repeat(128)).success).toBe(true);
  });
  it('rejects empty, overlong, dotted names', () => {
    expect(VarNameSchema.safeParse('').success).toBe(false);
    expect(VarNameSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(VarNameSchema.safeParse('a.b').success).toBe(false);
  });
  it('rejects prototype-polluting keys (C3)', () => {
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      expect(VarNameSchema.safeParse(k).success).toBe(false);
    }
  });
});

describe('JsonValueSchema', () => {
  it('accepts JSON values with finite numbers', () => {
    expect(JsonValueSchema.safeParse({ a: [1, 'x', true, null] }).success).toBe(true);
  });
  it('rejects non-finite numbers', () => {
    expect(JsonValueSchema.safeParse(Infinity).success).toBe(false);
    expect(JsonValueSchema.safeParse(NaN).success).toBe(false);
    expect(JsonValueSchema.safeParse({ a: Infinity }).success).toBe(false);
  });
  it('rejects undefined and functions', () => {
    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(JsonValueSchema.safeParse(() => 1).success).toBe(false);
  });
});

describe('ConditionSchema', () => {
  it('parses every valid operator', () => {
    const cases = [
      { op: 'and', conditions: [{ op: 'has', var: 'x' }] },
      { op: 'or', conditions: [{ op: 'has', var: 'x' }] },
      { op: 'not', condition: { op: 'has', var: 'x' } },
      { op: 'eq', var: 'x', value: 1 },
      { op: 'ne', var: 'x', value: null },
      { op: 'gt', var: 'x', value: 1.5 },
      { op: 'gte', var: 'x', value: 0 },
      { op: 'lt', var: 'x', value: -3 },
      { op: 'lte', var: 'x', value: 99 },
      { op: 'has', var: 'sword' },
      { op: 'in', var: 'align', values: ['good', 'neutral'] },
    ];
    for (const c of cases) {
      expect(ConditionSchema.safeParse(c).success, JSON.stringify(c)).toBe(true);
    }
  });
  it('rejects unknown operators', () => {
    expect(ConditionSchema.safeParse({ op: 'xor', var: 'x' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ op: 'contains', var: 'x', value: 'y' }).success).toBe(false);
  });
  it('rejects empty and/or arrays', () => {
    expect(ConditionSchema.safeParse({ op: 'and', conditions: [] }).success).toBe(false);
    expect(ConditionSchema.safeParse({ op: 'or', conditions: [] }).success).toBe(false);
  });
  it('rejects malformed shapes', () => {
    expect(ConditionSchema.safeParse({ op: 'gt', var: 'x', value: 'not-a-number' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ op: 'gt', var: 'x', value: Infinity }).success).toBe(false);
    expect(ConditionSchema.safeParse({ op: 'in', var: 'x', values: [] }).success).toBe(false);
    expect(ConditionSchema.safeParse({ op: 'has' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ op: 'not' }).success).toBe(false);
    expect(ConditionSchema.safeParse({}).success).toBe(false);
  });
  it('rejects unknown fields (strict)', () => {
    expect(
      ConditionSchema.safeParse({ op: 'has', var: 'x', extra: true }).success
    ).toBe(false);
  });
  it('rejects nested invalid conditions', () => {
    const bad = {
      op: 'and',
      conditions: [{ op: 'has', var: 'x' }, { op: 'bogus' }],
    };
    expect(ConditionSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects unsafe var names in conditions (C3)', () => {
    expect(ConditionSchema.safeParse({ op: 'has', var: '__proto__' }).success).toBe(false);
  });
});

describe('MutationSchema', () => {
  it('parses every valid operator', () => {
    const cases = [
      { op: 'set', var: 'x', value: { nested: [1, 2] } },
      { op: 'inc', var: 'gold', by: 5 },
      { op: 'dec', var: 'gold', by: 2 },
      { op: 'inc', var: 'gold', by: -3 },
      { op: 'toggle', var: 'flag' },
      { op: 'unset', var: 'temp' },
    ];
    for (const m of cases) {
      expect(MutationSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
    }
  });
  it('rejects unknown operators', () => {
    expect(MutationSchema.safeParse({ op: 'multiply', var: 'x', by: 2 }).success).toBe(false);
  });
  it('rejects non-finite by', () => {
    expect(MutationSchema.safeParse({ op: 'inc', var: 'x', by: Infinity }).success).toBe(false);
    expect(MutationSchema.safeParse({ op: 'dec', var: 'x', by: NaN }).success).toBe(false);
  });
  it('rejects malformed shapes', () => {
    expect(MutationSchema.safeParse({ op: 'set', var: 'x' }).success).toBe(false);
    expect(MutationSchema.safeParse({ op: 'inc', var: 'x' }).success).toBe(false);
    expect(MutationSchema.safeParse({ op: 'toggle' }).success).toBe(false);
  });
  it('rejects unsafe var names in mutations (C3)', () => {
    expect(MutationSchema.safeParse({ op: 'set', var: 'constructor', value: 1 }).success).toBe(false);
  });
  it('MutationListSchema parses arrays', () => {
    expect(MutationListSchema.safeParse([]).success).toBe(true);
    expect(
      MutationListSchema.safeParse([{ op: 'set', var: 'x', value: 1 }]).success
    ).toBe(true);
    expect(MutationListSchema.safeParse({}).success).toBe(false);
  });
});

describe('GrammarMarkerSchema', () => {
  it('accepts literal 1 and undefined, rejects everything else', () => {
    expect(GrammarMarkerSchema.safeParse(1).success).toBe(true);
    expect(GrammarMarkerSchema.safeParse(undefined).success).toBe(true);
    expect(GrammarMarkerSchema.safeParse(2).success).toBe(false);
    expect(GrammarMarkerSchema.safeParse('1').success).toBe(false);
  });
  it('does NOT apply a default (B12)', () => {
    // Optional without default: parsing {} must not inject the marker.
    const parsed = zObjectWithMarker().safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('condition_grammar_version' in parsed.data).toBe(false);
    }
  });
});

function zObjectWithMarker() {
  return z.object({ condition_grammar_version: GrammarMarkerSchema });
}

describe('grammar limits constants', () => {
  it('matches ADR-015 §2', () => {
    expect(MAX_CONDITION_DEPTH).toBe(10);
    expect(MAX_CONDITION_NODES).toBe(100);
    expect(MAX_MUTATIONS_PER_CHOICE).toBe(50);
  });
});
