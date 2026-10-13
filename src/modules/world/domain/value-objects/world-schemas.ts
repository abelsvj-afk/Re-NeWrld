import { z } from 'zod';

// JSON-compatible value schema for authoring metadata, attributes, conditions, and mutations.
// Note: Formal AST condition rules and mutation semantics are deferred to G1/G2.
const jsonLiteralSchema = z.union([
  z.string(),
  z.number().refine((n) => Number.isFinite(n), { message: 'Must be a finite number (excluding NaN, Infinity, -Infinity)' }),
  z.boolean(),
  z.null(),
]);
type JsonType = z.infer<typeof jsonLiteralSchema> | JsonType[] | { [key: string]: JsonType };

const jsonSchema: z.ZodType<JsonType> = z.lazy(() =>
  z.union([jsonLiteralSchema, z.array(jsonSchema), z.record(jsonSchema)])
);

const jsonObjectSchema = z.record(jsonSchema);

export const ConditionSchema = jsonObjectSchema;
export const MutationSchema = jsonObjectSchema;
export const CharacterAttributesSchema = jsonObjectSchema;
export const SceneMetadataSchema = jsonObjectSchema;

// Dedicated bounded WorldMetadata schema:
// - Depth definition:
//   * Depth 1 (Root): An object with up to 50 keys.
//   * Depth 2 (Child): Primitive literals, arrays of literals (max 50 items), or nested objects (max 50 keys).
//   * Depth 3 (Sub-child): Primitive literals, arrays of literals (max 50 items), or nested objects of leaf literals (max 50 keys).
//   * Values within depth 3 objects are strictly leaf literals or arrays of literals (depth 4 objects/arrays are rejected).
// - All strings <= 1,000 characters.
// - All numbers must be finite.
// - All arrays <= 50 elements.
// - All object key counts <= 50.
const worldMetadataStringSchema = z.string().max(1000, { message: 'Metadata string cannot exceed 1000 characters' });
const worldMetadataLiteralSchema = z.union([
  worldMetadataStringSchema,
  z.number().refine((n) => Number.isFinite(n), { message: 'Must be a finite number (excluding NaN, Infinity, -Infinity)' }),
  z.boolean(),
  z.null(),
]);

// Leaf values: literals or arrays of literals
const worldMetadataLeafValueSchema = z.union([
  worldMetadataLiteralSchema,
  z.array(worldMetadataLiteralSchema).max(50, { message: 'Metadata array cannot exceed 50 items' }),
]);

// Depth 3 object: Map of leaf values (literals or arrays of literals, no further nested objects)
const worldMetadataDepth3ObjectSchema = z.record(worldMetadataLeafValueSchema).refine(
  (obj) => Object.keys(obj).length <= 50,
  { message: 'Metadata child object cannot exceed 50 keys' }
);

// Depth 2 value: Literal, array of literals, or depth 3 object
const worldMetadataDepth2ValueSchema = z.union([
  worldMetadataLiteralSchema,
  z.array(worldMetadataLiteralSchema).max(50, { message: 'Metadata array cannot exceed 50 items' }),
  worldMetadataDepth3ObjectSchema,
]);

// Depth 2 object: Map of depth 2 values
const worldMetadataDepth2ObjectSchema = z.record(worldMetadataDepth2ValueSchema).refine(
  (obj) => Object.keys(obj).length <= 50,
  { message: 'Metadata child object cannot exceed 50 keys' }
);

// Depth 1 (Root) value: Literal, array of literals, or depth 2 object
const worldMetadataDepth1ValueSchema = z.union([
  worldMetadataLiteralSchema,
  z.array(worldMetadataLiteralSchema).max(50, { message: 'Metadata array cannot exceed 50 items' }),
  worldMetadataDepth2ObjectSchema,
]);

// Root object: Max 50 top-level keys
export const WorldMetadataSchema = z.record(worldMetadataDepth1ValueSchema).refine(
  (obj) => Object.keys(obj).length <= 50,
  { message: 'World metadata cannot exceed 50 top-level keys' }
);

export type ConditionPayload = z.infer<typeof ConditionSchema>;
export type MutationPayload = z.infer<typeof MutationSchema>;
export type CharacterAttributes = z.infer<typeof CharacterAttributesSchema>;
export type WorldMetadata = z.infer<typeof WorldMetadataSchema>;
export type SceneMetadata = z.infer<typeof SceneMetadataSchema>;
