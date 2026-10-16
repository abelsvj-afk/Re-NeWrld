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

// G1 (ADR-015 §10): conditions/mutations stay LOOSE at the authoring
// boundary — any JSON value. Strict grammar validation is a publish-time
// gate (G1c), not an authoring-time gate. In particular, mutations are
// ARRAYS in the v1 grammar, which an object-only schema would reject.
export const ConditionSchema: z.ZodType<JsonType> = jsonSchema;
export const MutationSchema: z.ZodType<JsonType> = jsonSchema;
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
const worldMetadataBaseSchema = z.record(worldMetadataDepth1ValueSchema).refine(
  (obj) => Object.keys(obj).length <= 50,
  { message: 'World metadata cannot exceed 50 top-level keys' }
);

// --- Discovery taxonomy (H-UX2) ---
// Genre is a closed enum for coherent browsing; tags are validated freeform.
// Both live in the existing metadata JSONB — no migration required.
export const WorldGenreSchema = z.enum([
  'fantasy',
  'sci-fi',
  'romance',
  'mystery',
  'horror',
  'adventure',
  'drama',
  'comedy',
  'historical',
  'other',
]);
export type WorldGenre = z.infer<typeof WorldGenreSchema>;
export const WORLD_GENRES: WorldGenre[] = WorldGenreSchema.options;

export const WorldTagSchema = z.string()
  .trim().toLowerCase()
  .min(1, { message: 'Tag cannot be empty' })
  .max(30, { message: 'Tag cannot exceed 30 characters' })
  .regex(/^[a-z0-9-]+$/, { message: 'Tags must be lowercase alphanumeric with hyphens' });

const worldTaxonomySchema = z.object({
  genre: WorldGenreSchema.optional(),
  tags: z.array(WorldTagSchema).max(10, { message: 'Cannot exceed 10 tags' }).optional(),
});

// Note: .and() intersection is not used here because the taxonomy side
// applies transforms (trim/lowercase) that the base record side does not —
// Zod intersections cannot merge differing outputs. Instead, validate and
// normalize taxonomy keys in a transform after base validation.
//
// Backward compatibility: genre values predating the closed enum are
// tolerated on READ (coerced to uncategorized) so existing worlds never
// become unloadable. Strict enum validation applies on WRITE paths
// (create/update request bodies parsed separately).
export const WorldMetadataSchema = worldMetadataBaseSchema.transform((obj) => {
  const result: Record<string, unknown> = { ...obj };
  if (result.genre !== undefined) {
    const parsed = WorldGenreSchema.safeParse(result.genre);
    if (parsed.success) {
      result.genre = parsed.data;
    } else {
      // Unknown legacy genre: drop the key rather than fail the read.
      delete result.genre;
    }
  }
  if (result.tags !== undefined) {
    const parsed = z.array(WorldTagSchema).max(10, { message: 'Cannot exceed 10 tags' }).safeParse(result.tags);
    if (parsed.success) {
      result.tags = parsed.data;
    } else {
      delete result.tags;
    }
  }
  return result as z.infer<typeof worldTaxonomySchema> & Record<string, unknown>;
});

/** Strict write-path validation for taxonomy input (create/update). */
export const WorldTaxonomyInputSchema = worldTaxonomySchema;

export type ConditionPayload = z.infer<typeof ConditionSchema>;
export type MutationPayload = z.infer<typeof MutationSchema>;
export type CharacterAttributes = z.infer<typeof CharacterAttributesSchema>;
export type WorldMetadata = z.infer<typeof WorldMetadataSchema>;
export type SceneMetadata = z.infer<typeof SceneMetadataSchema>;
