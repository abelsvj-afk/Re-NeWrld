import type { Mutation } from '../../../world/application/index.js';
import type { SessionState } from './condition-evaluator.js';
import { MutationApplicationError } from '../errors/choice.errors.js';

/**
 * Pure mutation applier (Task G1b, ADR-015 D1a + D1b).
 *
 * - Works on a FRESH DEEP COPY of the input — never mutates the caller's object.
 * - Applies mutations in array order to the working copy.
 * - Returns `{ state, applied }` ONLY when ALL mutations succeed; on the
 *   first invalid mutation it throws `MutationApplicationError` with the
 *   input object untouched (no partial leakage).
 * - Deterministic: no randomness, no clock, no I/O.
 *
 * Operates on PARSED mutations. Parse failures (unknown op, malformed shape,
 * non-finite operand) are handled by the caller per the marker-dependent
 * policy — never inside this module. Only APPLICABILITY failures throw here.
 */

export type AppliedMutation =
  | { op: 'set' | 'inc' | 'dec' | 'toggle'; var: string; value: unknown }
  | { op: 'unset'; var: string; removed: boolean };

export interface ApplyMutationsResult {
  /** The complete resulting state (not a diff) — safe to persist wholesale. */
  state: SessionState;
  /** Ordered records of what was applied, for the response + timeline. */
  applied: AppliedMutation[];
}

function hasKey(state: SessionState, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, key);
}

function fail(message: string): never {
  throw new MutationApplicationError(message);
}

export function applyMutations(
  state: SessionState,
  mutations: Mutation[]
): ApplyMutationsResult {
  // Deep copy first: the caller's object is never touched, even on failure.
  const working: SessionState = structuredClone(state);
  const applied: AppliedMutation[] = [];

  for (const mutation of mutations) {
    switch (mutation.op) {
      case 'set': {
        const value = structuredClone(mutation.value);
        working[mutation.var] = value;
        applied.push({ op: 'set', var: mutation.var, value });
        break;
      }
      case 'inc':
      case 'dec': {
        if (!hasKey(working, mutation.var)) {
          fail(`Cannot ${mutation.op} missing variable '${mutation.var}'`);
        }
        const current = working[mutation.var];
        if (typeof current !== 'number' || !Number.isFinite(current)) {
          fail(`Cannot ${mutation.op} non-numeric variable '${mutation.var}'`);
        }
        // `by` is finite per the grammar (Phase 1); a non-finite RESULT is
        // a Phase 2 applicability failure (ADR-015 B17).
        const delta = mutation.op === 'inc' ? mutation.by : -mutation.by;
        const result = current + delta;
        if (!Number.isFinite(result)) {
          fail(`Arithmetic overflow applying '${mutation.op}' to '${mutation.var}'`);
        }
        working[mutation.var] = result;
        applied.push({ op: mutation.op, var: mutation.var, value: result });
        break;
      }
      case 'toggle': {
        if (!hasKey(working, mutation.var)) {
          working[mutation.var] = true;
          applied.push({ op: 'toggle', var: mutation.var, value: true });
        } else if (typeof working[mutation.var] === 'boolean') {
          const value = !working[mutation.var];
          working[mutation.var] = value;
          applied.push({ op: 'toggle', var: mutation.var, value });
        } else {
          fail(`Cannot toggle non-boolean variable '${mutation.var}'`);
        }
        break;
      }
      case 'unset': {
        if (hasKey(working, mutation.var)) {
          delete working[mutation.var];
          applied.push({ op: 'unset', var: mutation.var, removed: true });
        } else {
          applied.push({ op: 'unset', var: mutation.var, removed: false });
        }
        break;
      }
    }
  }

  return { state: working, applied };
}
