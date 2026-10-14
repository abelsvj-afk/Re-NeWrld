import { z } from 'zod';

/**
 * Authoritative v1 contract for `published_canon_snapshots.canon_data`
 * (Task E2a, ADR-013).
 *
 * The snapshot is the immutable, reader-facing canon: exactly what session
 * execution needs, nothing else. All objects are `.strict()` — unknown
 * fields are rejected so the v1 contract stays precise.
 *
 * Included: world identity/content/start scene; scenes (full content,
 * `chapter_id` preserved as an opaque UUID); choices (full fields,
 * conditions/mutations carried opaquely per Option A — semantic validation
 * deferred to G1).
 *
 * Excluded: `created_at`/`updated_at` (mutable metadata, not canon),
 * `creator_id` (provenance lives on the `worlds` row; the snapshot row
 * already carries `world_id`), chapter metadata (titles/ordering/behavior
 * are outside the v1 contract — see ADR-013).
 *
 * Evolution rule: readers must check `canon_schema_version` and reject
 * unknown versions loudly. A future v2 must define forward/backward
 * compatibility and snapshot migration behavior.
 */
const canonWorldSchema = z
  .object({
    world_id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    metadata: z.record(z.unknown()),
    start_scene_id: z.string().uuid(),
  })
  .strict();

const canonSceneSchema = z
  .object({
    scene_id: z.string().uuid(),
    chapter_id: z.string().uuid(),
    title: z.string(),
    prose: z.string(),
    metadata: z.record(z.unknown()),
    is_ending: z.boolean(),
  })
  .strict();

const canonChoiceSchema = z
  .object({
    choice_id: z.string().uuid(),
    scene_id: z.string().uuid(),
    target_scene_id: z.string().uuid(),
    text: z.string(),
    // Absent = unconditional (ADR-015 §2). Loose (not grammar-validated)
    // because this schema also READS legacy pre-G1 snapshots: legacy `{}`
    // conditions are grandfathered as unconditional at runtime, and other
    // legacy payloads fail closed per the marker policy. Strict grammar
    // validation happens at publish time (G1c), not here.
    conditions: z.unknown().optional(),
    // Absent ≡ [] (ADR-015 B20). Same legacy-read leniency as conditions.
    mutations: z.unknown().optional(),
    sort_order: z.number().int(),
  })
  .strict();

export const CanonDataSchema = z
  .object({
    canon_schema_version: z.literal(1),
    // Grammar version marker (ADR-015 §10, B12): optional with NO default.
    // Presence is tracked explicitly — a default would erase the
    // legacy/validated distinction the runtime failure policy depends on.
    // Newly published canon always carries `1` (G1c validated it).
    condition_grammar_version: z.literal(1).optional(),
    world: canonWorldSchema,
    scenes: z.array(canonSceneSchema),
    choices: z.array(canonChoiceSchema),
  })
  .strict();

export type CanonData = z.infer<typeof CanonDataSchema>;
