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
    conditions: z.record(z.unknown()),
    mutations: z.record(z.unknown()),
    sort_order: z.number().int(),
  })
  .strict();

export const CanonDataSchema = z
  .object({
    canon_schema_version: z.literal(1),
    world: canonWorldSchema,
    scenes: z.array(canonSceneSchema),
    choices: z.array(canonChoiceSchema),
  })
  .strict();

export type CanonData = z.infer<typeof CanonDataSchema>;
