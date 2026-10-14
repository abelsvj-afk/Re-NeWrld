import {
  ConditionSchema,
  MutationListSchema,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  MAX_MUTATIONS_PER_CHOICE,
  type Condition,
  type Mutation,
} from './grammar.schema.js';

/**
 * Publish-time semantic validation (Task G1a/G1c, ADR-015 D1a).
 *
 * Walks a choice's conditions/mutations and reports every violation:
 * shape violations (via the Zod grammar schemas) plus nesting limits
 * (depth 10, 100 nodes, 50 mutations per choice — ADR-015 §2).
 *
 * At publish time each violation is a BLOCKER (422, FR-05 taxonomy).
 * At runtime the caller applies the marker-dependent policy instead
 * (ADR-015 D1a two-phase boundary) — this module only reports.
 */

export interface SemanticViolation {
  /** Machine-readable code, e.g. 'UNKNOWN_OPERATOR', 'NESTING_TOO_DEEP'. */
  code: string;
  /** Human-readable diagnostic for the creator. */
  message: string;
  /** Which payload: 'conditions' or 'mutations'. */
  payload: 'conditions' | 'mutations';
}

function violation(
  code: string,
  payload: 'conditions' | 'mutations',
  message: string
): SemanticViolation {
  return { code, payload, message };
}

/** Count condition nodes and track max depth. */
function analyzeCondition(condition: Condition): { nodes: number; depth: number } {
  switch (condition.op) {
    case 'and':
    case 'or': {
      let nodes = 1;
      let depth = 1;
      for (const child of condition.conditions) {
        const sub = analyzeCondition(child);
        nodes += sub.nodes;
        depth = Math.max(depth, 1 + sub.depth);
      }
      return { nodes, depth };
    }
    case 'not': {
      const sub = analyzeCondition(condition.condition);
      return { nodes: 1 + sub.nodes, depth: 1 + sub.depth };
    }
    default:
      return { nodes: 1, depth: 1 };
  }
}

/**
 * Validate one choice's conditions/mutations. Returns all violations found
 * (empty = valid). `conditions` may be undefined (unconditional — valid);
 * `{}` is rejected (ADR-015 §2: exactly one representation of "no condition").
 * `mutations` may be undefined (equivalent to `[]` — ADR-015 B20).
 */
export function validateChoiceSemantics(
  conditions: unknown,
  mutations: unknown
): SemanticViolation[] {
  const violations: SemanticViolation[] = [];

  // --- Conditions ---
  if (conditions === undefined) {
    // Unconditional — valid.
  } else if (
    conditions !== null &&
    typeof conditions === 'object' &&
    Object.keys(conditions).length === 0
  ) {
    violations.push(
      violation(
        'EMPTY_CONDITION_OBJECT',
        'conditions',
        'Empty object {} is not a valid condition: omit `conditions` for an unconditional choice.'
      )
    );
  } else {
    const parsed = ConditionSchema.safeParse(conditions);
    if (!parsed.success) {
      violations.push(
        violation(
          'INVALID_CONDITION',
          'conditions',
          `Condition does not satisfy the v1 grammar: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`
        )
      );
    } else {
      const { nodes, depth } = analyzeCondition(parsed.data);
      if (depth > MAX_CONDITION_DEPTH) {
        violations.push(
          violation(
            'NESTING_TOO_DEEP',
            'conditions',
            `Condition depth ${depth} exceeds the maximum of ${MAX_CONDITION_DEPTH}.`
          )
        );
      }
      if (nodes > MAX_CONDITION_NODES) {
        violations.push(
          violation(
            'TOO_MANY_NODES',
            'conditions',
            `Condition has ${nodes} nodes, exceeding the maximum of ${MAX_CONDITION_NODES}.`
          )
        );
      }
    }
  }

  // --- Mutations ---
  if (mutations === undefined) {
    // Absent ≡ [] (ADR-015 B20) — valid.
  } else {
    const parsed = MutationListSchema.safeParse(mutations);
    if (!parsed.success) {
      violations.push(
        violation(
          'INVALID_MUTATION',
          'mutations',
          `Mutations do not satisfy the v1 grammar: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`
        )
      );
    } else if (parsed.data.length > MAX_MUTATIONS_PER_CHOICE) {
      violations.push(
        violation(
          'TOO_MANY_MUTATIONS',
          'mutations',
          `Choice has ${parsed.data.length} mutations, exceeding the maximum of ${MAX_MUTATIONS_PER_CHOICE}.`
        )
      );
    }
  }

  return violations;
}

/** Parsed, validated mutations (absent ≡ []). For runtime use after the marker policy check. */
export function parseMutations(mutations: unknown): Mutation[] {
  if (mutations === undefined) return [];
  return MutationListSchema.parse(mutations);
}
