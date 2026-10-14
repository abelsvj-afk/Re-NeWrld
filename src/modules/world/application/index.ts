/**
 * World module public facade (STOP-3, expanded H-facade).
 *
 * This is the ONLY sanctioned entry point for cross-module imports from the
 * world module. Per docs/repository-architecture.md §B (Strict Isolation),
 * inter-module communication must occur exclusively through designated public
 * facades — direct deep imports of `world/domain/...` or
 * `world/infrastructure/...` from other modules are prohibited (enforced by
 * tests/unit/import-boundaries.test.ts).
 *
 * Exposed surface:
 * - Grammar schema types and parsers (Condition, Mutation, Zod schemas)
 * - Grammar marker helper (getGrammarMarker)
 * - Semantic validator (validateChoiceSemantics, parseMutations)
 * - Value objects (WorldId, SceneId, ChoiceId, SnapshotId)
 * - Repository ports (WorldRepositoryPort, CanonRepositoryPort)
 * - Entities (CanonSnapshot)
 * - Domain errors (WorldNotFoundError)
 *
 * It deliberately does NOT re-export infrastructure adapters or private helpers.
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
export { WorldId } from '../domain/value-objects/world-id.value-object.js';
export { SceneId } from '../domain/value-objects/scene-id.value-object.js';
export { ChoiceId } from '../domain/value-objects/choice-id.value-object.js';
export { SnapshotId } from '../domain/value-objects/snapshot-id.value-object.js';
export { type WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
export { type CanonRepositoryPort } from '../domain/ports/canon.repository.port.js';
export { CanonSnapshot } from '../domain/entities/canon-snapshot.entity.js';
export { WorldNotFoundError } from '../domain/errors/world.errors.js';
