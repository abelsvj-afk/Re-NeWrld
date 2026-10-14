/**
 * World module public facade (STOP-3).
 *
 * This is the ONLY sanctioned entry point for cross-module imports from the
 * world module. Per docs/repository-architecture.md §B (Strict Isolation),
 * inter-module communication must occur exclusively through designated public
 * facades — direct deep imports of `world/domain/...` or
 * `world/infrastructure/...` from other modules are prohibited (enforced by
 * tests/unit/import-boundaries.test.ts).
 *
 * This facade exposes the MINIMUM surface the session module needs:
 * - Grammar schema types and parsers (Condition, Mutation, Zod schemas)
 * - Grammar marker helper (getGrammarMarker)
 *
 * It deliberately does NOT re-export entities, repositories, or infrastructure.
 * Session needs ports and value objects too, but those pre-date the facade
 * (Phase F debt, TASKS.md H-facade) and migrate separately.
 */
export {
  ConditionSchema,
  MutationSchema,
  MutationListSchema,
  JsonValueSchema,
  GrammarMarkerSchema,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  MAX_MUTATIONS_PER_CHOICE,
  type Condition,
  type Mutation,
  type JsonValue,
} from '../domain/services/grammar.schema.js';
export {
  getGrammarMarker,
  type GrammarMarkerInfo,
} from '../domain/services/grammar-marker.js';
export {
  validateChoiceSemantics,
  parseMutations,
  type SemanticViolation,
} from '../domain/services/semantic-validator.js';
