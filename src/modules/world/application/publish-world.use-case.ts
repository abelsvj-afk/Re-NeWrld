import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { ChoiceRepositoryPort } from '../domain/ports/choice.repository.port.js';
import { CanonRepositoryPort } from '../domain/ports/canon.repository.port.js';
import { World } from '../domain/entities/world.entity.js';
import { Scene } from '../domain/entities/scene.entity.js';
import { Choice } from '../domain/entities/choice.entity.js';
import { CanonSnapshot } from '../domain/entities/canon-snapshot.entity.js';
import { SnapshotId } from '../domain/value-objects/snapshot-id.value-object.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import {
  CanonData,
  CanonDataSchema,
} from '../domain/value-objects/canon-data.schema.js';
import {
  validateWorldGraph,
  validateChoiceReferences,
  validateChoiceSemanticsForPublish,
} from '../domain/services/graph-validator.js';
import {
  WorldNotFoundError,
  PublishingValidationError,
} from '../domain/errors/world.errors.js';
import { withTransaction } from '../../../shared/database/db.js';

export interface PublishWorldCommand {
  worldId: WorldId;
  creatorId: UserId;
}

export interface PublishWorldResult {
  snapshot: CanonSnapshot;
  /** Unreachable-scene warnings; preserved, never blockers. */
  warnings: string[];
}

/**
 * Serializes a world's draft graph into the v1 canon contract.
 * Pure function — exported for direct unit testing.
 */
export function buildCanonData(world: World, scenes: Scene[], choices: Choice[]): CanonData {
  const startSceneId = world.getStartSceneId();
  if (startSceneId === null) {
    throw new Error('Cannot build canon data for a world with no start scene');
  }
  return {
    canon_schema_version: 1,
    // G1c validated every choice's grammar — this snapshot is marked v1.
    condition_grammar_version: 1,
    world: {
      world_id: world.getWorldId().getValue(),
      title: world.getTitle(),
      description: world.getDescription(),
      metadata: world.getMetadata(),
      start_scene_id: startSceneId.getValue(),
    },
    scenes: scenes.map((scene) => ({
      scene_id: scene.getSceneId().getValue(),
      chapter_id: scene.getChapterId().getValue(),
      title: scene.getTitle(),
      prose: scene.getProse(),
      metadata: scene.getMetadata(),
      is_ending: scene.getIsEnding(),
    })),
    choices: choices.map((choice) => ({
      choice_id: choice.getChoiceId().getValue(),
      scene_id: choice.getSceneId().getValue(),
      target_scene_id: choice.getTargetSceneId().getValue(),
      text: choice.getText(),
      conditions: choice.getConditions(),
      mutations: choice.getMutations(),
      sort_order: choice.getSortOrder(),
      visibility: choice.getVisibility(),
    })),
  };
}

/**
 * Creator-triggered world publishing (Task E2a).
 *
 * Runs the E1a/E1b validators over the world's draft graph. On blockers,
 * throws `PublishingValidationError` (HTTP 422) with the full report and
 * writes nothing. On pass, appends a new immutable snapshot version and
 * flips the world to published — snapshot insert and world save share one
 * transaction client, so a failure cannot leave a partial publication.
 *
 * Re-publishing an already-published world is allowed: every successful
 * publish creates a new immutable version. `revertToDraft()` is not a
 * precondition.
 *
 * Failure atomicity: this use case loads the world itself and never
 * returns it on the throw path, so a rolled-back `world.publish()` can
 * never be observed by callers.
 */
export class PublishWorldUseCase {
  constructor(
    private readonly worlds: WorldRepositoryPort,
    private readonly scenes: SceneRepositoryPort,
    private readonly choices: ChoiceRepositoryPort,
    private readonly canon: CanonRepositoryPort
  ) {}

  public async execute(command: PublishWorldCommand): Promise<PublishWorldResult> {
    const world = await this.worlds.findById(command.worldId);
    if (world === null || !world.getCreatorId().equals(command.creatorId)) {
      // 404-not-403: never reveal whether a world id exists for another creator.
      throw new WorldNotFoundError();
    }

    const [scenes, choices] = await Promise.all([
      this.scenes.findByWorldId(world.getWorldId()),
      this.choices.findByWorldId(world.getWorldId()),
    ]);

    const graph = validateWorldGraph(world, scenes, choices);
    const refs = validateChoiceReferences(scenes, choices);
    // G1c: grammar blockers (unknown ops, malformed shapes, {} conditions…)
    const semantics = validateChoiceSemanticsForPublish(choices);
    const blockers = [...graph.errors, ...refs.dangling, ...semantics.blockers];
    if (blockers.length > 0) {
      throw new PublishingValidationError({
        blockers,
        warnings: graph.unreachable,
      });
    }

    const parsed = CanonDataSchema.safeParse(buildCanonData(world, scenes, choices));
    if (!parsed.success) {
      // Server-side invariant violation: our own validated entities
      // produced canon data outside the v1 contract. Never a client error.
      throw new Error('Canon serialization invariant violated: built canon_data failed v1 schema');
    }

    return withTransaction(async (tx) => {
      const version = await this.canon.nextVersion(world.getWorldId(), tx);
      const snapshot = CanonSnapshot.create({
        snapshotId: SnapshotId.generate(),
        worldId: world.getWorldId(),
        versionNumber: version,
        canonData: parsed.data,
      });
      await this.canon.insert(snapshot, tx);
      world.publish();
      await this.worlds.save(world, tx);
      return { snapshot, warnings: graph.unreachable };
    });
  }
}
