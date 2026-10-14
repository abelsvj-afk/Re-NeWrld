import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../../src/modules/session/domain/services/condition-evaluator.js';
import { applyMutations } from '../../src/modules/session/domain/services/mutation-applier.js';
import type { Condition, Mutation } from '../../src/modules/world/domain/services/grammar.schema.js';

/**
 * Performance benchmarks (ADR-015 §6, G2 test matrix).
 *
 * - Pure evaluation budget: the G1 evaluator + applier over a max-bounds
 *   payload (depth 10, 100 nodes, 50 mutations) must complete in <10ms.
 * - These are benchmarks, not strict gates: they fail loudly if the budget
 *   is exceeded so regressions are caught.
 */

// Build a max-bounds condition: depth 10, ~100 nodes.
function maxBoundsCondition(): Condition {
  // 99 leaf conditions under one `and` = 100 nodes, depth 2. Plus a
  // depth-10 chain to exercise nesting.
  let deep: Condition = { op: 'has', var: 'x' };
  for (let i = 0; i < 9; i++) {
    deep = { op: 'not', condition: deep };
  }
  const leaves: Condition[] = Array.from({ length: 90 }, (_, i) => ({
    op: 'eq',
    var: `v${i}`,
    value: i,
  }));
  return { op: 'and', conditions: [...leaves, deep] };
}

function maxBoundsMutations(): Mutation[] {
  return Array.from({ length: 50 }, (_, i) => ({
    op: 'set' as const,
    var: `v${i}`,
    value: i,
  }));
}

describe('G1 performance budgets', () => {
  it('evaluator + applier over max-bounds payload complete in <10ms', () => {
    const condition = maxBoundsCondition();
    const mutations = maxBoundsMutations();
    const state: Record<string, unknown> = { x: 1 };
    for (let i = 0; i < 90; i++) state[`v${i}`] = i;

    // Warmup.
    evaluateCondition(condition, state);
    applyMutations(state, mutations);

    const iterations = 100;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      evaluateCondition(condition, state);
      applyMutations(state, mutations);
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const perOpMs = elapsedMs / iterations;
    console.log(`G1 pure p50: ${perOpMs.toFixed(3)}ms per evaluate+apply (max bounds)`);
    expect(perOpMs).toBeLessThan(10);
  });
});
