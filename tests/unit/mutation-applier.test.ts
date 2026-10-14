import { describe, it, expect } from 'vitest';
import { applyMutations } from '../../src/modules/session/domain/services/mutation-applier.js';
import { MutationApplicationError } from '../../src/modules/session/domain/errors/choice.errors.js';
import type { Mutation } from '../../src/modules/world/domain/services/grammar.schema.js';

describe('applyMutations', () => {
  it('set creates and replaces', () => {
    const r = applyMutations({}, [{ op: 'set', var: 'x', value: 1 }]);
    expect(r.state).toEqual({ x: 1 });
    expect(r.applied).toEqual([{ op: 'set', var: 'x', value: 1 }]);
    const r2 = applyMutations({ x: 1 }, [{ op: 'set', var: 'x', value: { deep: true } }]);
    expect(r2.state).toEqual({ x: { deep: true } });
  });
  it('inc/dec on numeric targets', () => {
    const r = applyMutations({ gold: 10 }, [
      { op: 'inc', var: 'gold', by: 5 },
      { op: 'dec', var: 'gold', by: 3 },
    ]);
    expect(r.state).toEqual({ gold: 12 });
    expect(r.applied).toEqual([
      { op: 'inc', var: 'gold', value: 15 },
      { op: 'dec', var: 'gold', value: 12 },
    ]);
  });
  it('inc/dec accept negative finite by (B17)', () => {
    const r = applyMutations({ gold: 10 }, [{ op: 'inc', var: 'gold', by: -3 }]);
    expect(r.state).toEqual({ gold: 7 });
  });
  it('inc/dec reject missing or non-numeric targets (422)', () => {
    expect(() => applyMutations({}, [{ op: 'inc', var: 'x', by: 1 }])).toThrow(
      MutationApplicationError
    );
    expect(() => applyMutations({ x: 's' }, [{ op: 'inc', var: 'x', by: 1 }])).toThrow(
      MutationApplicationError
    );
    expect(() => applyMutations({ x: null }, [{ op: 'dec', var: 'x', by: 1 }])).toThrow(
      MutationApplicationError
    );
  });
  it('rejects non-finite arithmetic results (B17)', () => {
    expect(() =>
      applyMutations({ x: 1e308 }, [{ op: 'inc', var: 'x', by: 1e308 }])
    ).toThrow(MutationApplicationError);
  });
  it('toggle flips booleans, sets true when missing', () => {
    expect(applyMutations({}, [{ op: 'toggle', var: 'f' }]).state).toEqual({ f: true });
    expect(applyMutations({ f: true }, [{ op: 'toggle', var: 'f' }]).state).toEqual({
      f: false,
    });
    expect(() => applyMutations({ f: 1 }, [{ op: 'toggle', var: 'f' }])).toThrow(
      MutationApplicationError
    );
  });
  it('unset removes present keys and reports removed:true; missing → removed:false (B7)', () => {
    const r = applyMutations({ a: 1, b: 2 }, [{ op: 'unset', var: 'a' }]);
    expect(r.state).toEqual({ b: 2 });
    expect(r.applied).toEqual([{ op: 'unset', var: 'a', removed: true }]);
    const r2 = applyMutations({ b: 2 }, [{ op: 'unset', var: 'a' }]);
    expect(r2.state).toEqual({ b: 2 });
    expect(r2.applied).toEqual([{ op: 'unset', var: 'a', removed: false }]);
  });
  it('applies in order with later mutations seeing earlier effects', () => {
    const r = applyMutations({}, [
      { op: 'set', var: 'x', value: 1 },
      { op: 'inc', var: 'x', by: 1 },
    ]);
    expect(r.state).toEqual({ x: 2 });
  });
  it('throws on first invalid mutation WITHOUT partial application (D1b)', () => {
    const input = { gold: 10, keep: 'yes' };
    const mutations: Mutation[] = [
      { op: 'inc', var: 'gold', by: 5 },
      { op: 'inc', var: 'missing', by: 1 },
    ];
    expect(() => applyMutations(input, mutations)).toThrow(MutationApplicationError);
    // Input untouched: no partial leakage.
    expect(input).toEqual({ gold: 10, keep: 'yes' });
  });
  it('does not mutate the input object on success either', () => {
    const input = { gold: 10 };
    const r = applyMutations(input, [{ op: 'inc', var: 'gold', by: 1 }]);
    expect(input).toEqual({ gold: 10 });
    expect(r.state).toEqual({ gold: 11 });
  });
  it('deep-copies set values (no aliasing)', () => {
    const value = { nested: [1] };
    const r = applyMutations({}, [{ op: 'set', var: 'x', value }]);
    (value.nested as number[]).push(2);
    expect(r.state).toEqual({ x: { nested: [1] } });
  });
  it('determinism: repeated application is byte-identical', () => {
    const ms: Mutation[] = [
      { op: 'set', var: 'a', value: 1 },
      { op: 'toggle', var: 'b' },
    ];
    const a = JSON.stringify(applyMutations({}, ms));
    const b = JSON.stringify(applyMutations({}, ms));
    expect(a).toBe(b);
  });
});
