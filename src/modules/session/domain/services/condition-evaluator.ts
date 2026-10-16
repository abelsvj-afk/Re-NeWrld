import type { Condition } from '../../../world/application/index.js';

/**
 * Pure condition evaluator (Task G1b, ADR-015 D1a).
 *
 * Total: never throws on data shape. Missing `var` → false (never
 * true-by-default). Type mismatches → false. Deterministic: same input
 * always yields same output — no randomness, no clock, no I/O.
 *
 * Operates on a PARSED Condition. Parse failures are handled by the caller
 * per the marker-dependent policy (ADR-015 D1a) — never inside this module.
 */

export type SessionState = Record<string, unknown>;

/** Deep equality with insignificant object key order (ADR-015 §2). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // NaN is not a valid JSON value; treat as unequal to everything.
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, (b as unknown[])[i]));
  }
  if (typeof a === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k])
    );
  }
  return false;
}

/** Key presence, including null-valued keys (ADR-015 §2 `has` semantics). */
function hasKey(state: SessionState, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, key);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function evaluateCondition(condition: Condition, state: SessionState): boolean {
  switch (condition.op) {
    case 'truthy':
      // Item A: bare {{#if variable}} — JavaScript truthiness semantics
      return hasKey(state, condition.var) && !!state[condition.var];
    case 'and':
      // Non-empty guaranteed by the grammar.
      return condition.conditions.every((c) => evaluateCondition(c, state));
    case 'or':
      return condition.conditions.some((c) => evaluateCondition(c, state));
    case 'not':
      return !evaluateCondition(condition.condition, state);
    case 'eq':
      return hasKey(state, condition.var) && deepEqual(state[condition.var], condition.value);
    case 'ne':
      return hasKey(state, condition.var) && !deepEqual(state[condition.var], condition.value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (!hasKey(state, condition.var)) return false;
      const actual = state[condition.var];
      if (!isFiniteNumber(actual)) return false;
      const expected = condition.value; // finite per the grammar
      if (condition.op === 'gt') return actual > expected;
      if (condition.op === 'gte') return actual >= expected;
      if (condition.op === 'lt') return actual < expected;
      return actual <= expected;
    }
    case 'has':
      return hasKey(state, condition.var);
    case 'in': {
      if (!hasKey(state, condition.var)) return false;
      const actual = state[condition.var];
      return condition.values.some((v) => deepEqual(actual, v));
    }
  }
}
