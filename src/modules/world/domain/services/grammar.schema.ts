import { z } from 'zod';

/**
 * G1 condition/mutation grammar schemas (Task G1a, ADR-015 §2, D1a).
 *
 * PLACEMENT: this grammar lives in the world module because it DEFINES
 * canon content — conditions/mutations are part of the world-owned Choice
 * entity, and publish-time validation (G1c) consumes it locally. The
 * session module's runtime interpreter (condition-evaluator,
 * mutation-applier) imports only the types from here. This keeps the
 * dependency direction session → world (the established direction) and
 * complies with the strict module isolation rule
 * (docs/repository-architecture.md) — a world → session import would
 * create a module cycle.
 *
 * Tagged-object grammar, Zod-validatable, deterministic. These schemas
 * enforce SHAPE (operand types, var rules, non-empty arrays, finite
 * numerics). Nesting limits (depth 10, 100 nodes, 50 mutations) are enforced
 * by the semantic validator (`semantic-validator.ts`) — Zod cannot express
 * them. Publish-time vs runtime failure policy lives in the callers
 * (ADR-015 D1a two-phase boundary).
 */

/** JSON values with finite numbers (ADR-015 §2 numeric rules). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
) as z.ZodType<JsonValue>;

/** Variable names that can never be safely assigned on a plain JS object. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Variable name rules (ADR-015 §2, C3): non-empty, max 128 chars, flat key
 * (no dots — nested paths are out of scope for MVP), and never one of the
 * prototype-polluting keys.
 */
export const VarNameSchema = z
  .string()
  .min(1, { message: 'Variable name must be non-empty' })
  .max(128, { message: 'Variable name must be at most 128 characters' })
  .refine((v) => !v.includes('.'), {
    message: 'Variable name must be a flat key (no dots)',
  })
  .refine((v) => !UNSAFE_KEYS.has(v), {
    message: 'Variable name is reserved (__proto__/constructor/prototype)',
  });

/** Condition grammar (ADR-015 §2). Recursive via z.lazy. */
export type Condition =
  | { op: 'and'; conditions: Condition[] }
  | { op: 'or'; conditions: Condition[] }
  | { op: 'not'; condition: Condition }
  | { op: 'eq'; var: string; value: JsonValue }
  | { op: 'ne'; var: string; value: JsonValue }
  | { op: 'gt'; var: string; value: number }
  | { op: 'gte'; var: string; value: number }
  | { op: 'lt'; var: string; value: number }
  | { op: 'lte'; var: string; value: number }
  | { op: 'has'; var: string }
  | { op: 'in'; var: string; values: JsonValue[] };

const finiteNumber = z.number().finite();

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z
      .object({ op: z.literal('and'), conditions: z.array(ConditionSchema).min(1) })
      .strict(),
    z
      .object({ op: z.literal('or'), conditions: z.array(ConditionSchema).min(1) })
      .strict(),
    z.object({ op: z.literal('not'), condition: ConditionSchema }).strict(),
    z.object({ op: z.literal('eq'), var: VarNameSchema, value: JsonValueSchema }).strict(),
    z.object({ op: z.literal('ne'), var: VarNameSchema, value: JsonValueSchema }).strict(),
    z.object({ op: z.literal('gt'), var: VarNameSchema, value: finiteNumber }).strict(),
    z.object({ op: z.literal('gte'), var: VarNameSchema, value: finiteNumber }).strict(),
    z.object({ op: z.literal('lt'), var: VarNameSchema, value: finiteNumber }).strict(),
    z.object({ op: z.literal('lte'), var: VarNameSchema, value: finiteNumber }).strict(),
    z.object({ op: z.literal('has'), var: VarNameSchema }).strict(),
    z
      .object({
        op: z.literal('in'),
        var: VarNameSchema,
        values: z.array(JsonValueSchema).min(1),
      })
      .strict(),
  ])
);

/** Mutation grammar (ADR-015 §2). Applied in array order. */
export type Mutation =
  | { op: 'set'; var: string; value: JsonValue }
  | { op: 'inc'; var: string; by: number }
  | { op: 'dec'; var: string; by: number }
  | { op: 'toggle'; var: string }
  | { op: 'unset'; var: string };

export const MutationSchema: z.ZodType<Mutation> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), var: VarNameSchema, value: JsonValueSchema }).strict(),
  z.object({ op: z.literal('inc'), var: VarNameSchema, by: finiteNumber }).strict(),
  z.object({ op: z.literal('dec'), var: VarNameSchema, by: finiteNumber }).strict(),
  z.object({ op: z.literal('toggle'), var: VarNameSchema }).strict(),
  z.object({ op: z.literal('unset'), var: VarNameSchema }).strict(),
]);

export const MutationListSchema = z.array(MutationSchema);

/**
 * Grammar version marker (ADR-015 §10, B12): optional in the transport
 * schema, with NO schema default. Presence is tracked explicitly by
 * `getGrammarMarker` — a default would erase the legacy/validated
 * distinction the failure policy depends on.
 */
export const GrammarMarkerSchema = z.literal(1).optional();

/** Nesting limits (ADR-015 §2) — enforced by the semantic validator. */
export const MAX_CONDITION_DEPTH = 10;
export const MAX_CONDITION_NODES = 100;
export const MAX_MUTATIONS_PER_CHOICE = 50;
