import { World } from '../entities/world.entity.js';
import { Scene } from '../entities/scene.entity.js';
import { Choice } from '../entities/choice.entity.js';
import { validateChoiceSemantics } from './semantic-validator.js';

/**
 * Blocker codes for the publishing-validation contract (ADR-013 §5,
 * detailed-design.md §7, FR-05). Unreachable but well-formed scenes are
 * warnings — they appear in `unreachable`, never in `errors`.
 */
export type GraphValidationErrorCode =
  | 'NO_SCENES'
  | 'START_SCENE_MISSING'
  | 'START_SCENE_NOT_FOUND'
  | 'NO_REACHABLE_ENDING';

export interface GraphValidationError {
  code: GraphValidationErrorCode;
  message: string;
}

export interface GraphValidationResult {
  /** Scene ids visited by traversal from the start scene, in discovery order. */
  reachable: string[];
  /** Scene ids never visited. Warnings only — never blockers. */
  unreachable: string[];
  /** Reachable scenes flagged as terminal endings (`is_ending`). */
  reachableEndings: string[];
  /** Blocking conditions. Empty means the graph portion of the contract passes. */
  errors: GraphValidationError[];
}

function err(code: GraphValidationErrorCode, message: string): GraphValidationError {
  return { code, message };
}

/**
 * Pure graph-reachability validator for publishing (Task E1a).
 *
 * Traverses the scene graph breadth-first from the world's designated start
 * scene (`world.getStartSceneId()`), following choice edges
 * (`choice.getSceneId()` → `choice.getTargetSceneId()`).
 *
 * Pure: no DB, no I/O, deterministic for a given input order. Cycles are
 * handled via a visited set. Choice targets that do not correspond to any
 * provided scene are skipped during traversal — dangling-target detection
 * is E1b's responsibility, not E1a's.
 *
 * Blocking conditions (per the publishing-validation contract):
 * - no scenes at all (`NO_SCENES`)
 * - world has no designated start scene (`START_SCENE_MISSING`)
 * - the designated start scene is not among the provided scenes
 *   (`START_SCENE_NOT_FOUND`; malformed input — the database FK prevents
 *   this for persisted worlds)
 * - no reachable terminal ending (`NO_REACHABLE_ENDING`)
 */
export function validateWorldGraph(
  world: World,
  scenes: Scene[],
  choices: Choice[]
): GraphValidationResult {
  if (scenes.length === 0) {
    return {
      reachable: [],
      unreachable: [],
      reachableEndings: [],
      errors: [err('NO_SCENES', 'World has no scenes to validate')],
    };
  }

  const startSceneId = world.getStartSceneId();
  if (startSceneId === null) {
    return {
      reachable: [],
      unreachable: scenes.map((s) => s.getSceneId().getValue()),
      reachableEndings: [],
      errors: [err('START_SCENE_MISSING', 'World has no designated start scene')],
    };
  }

  const sceneIds = new Set(scenes.map((s) => s.getSceneId().getValue()));
  const startValue = startSceneId.getValue();
  if (!sceneIds.has(startValue)) {
    return {
      reachable: [],
      unreachable: scenes.map((s) => s.getSceneId().getValue()),
      reachableEndings: [],
      errors: [
        err(
          'START_SCENE_NOT_FOUND',
          `Designated start scene ${startValue} is not among the world's scenes`
        ),
      ],
    };
  }

  // Adjacency: source scene id -> target scene ids, in input choice order.
  // Targets naming scenes outside the provided set are skipped here;
  // dangling-target detection belongs to E1b.
  const adjacency = new Map<string, string[]>();
  for (const choice of choices) {
    const from = choice.getSceneId().getValue();
    const to = choice.getTargetSceneId().getValue();
    if (!sceneIds.has(from) || !sceneIds.has(to)) {
      continue;
    }
    const targets = adjacency.get(from);
    if (targets) {
      targets.push(to);
    } else {
      adjacency.set(from, [to]);
    }
  }

  const endingById = new Map<string, boolean>();
  for (const scene of scenes) {
    endingById.set(scene.getSceneId().getValue(), scene.getIsEnding());
  }

  // Breadth-first traversal from the start scene.
  const visited = new Set<string>();
  const reachable: string[] = [];
  const queue: string[] = [startValue];
  visited.add(startValue);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    reachable.push(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const unreachable = scenes
    .map((s) => s.getSceneId().getValue())
    .filter((id) => !visited.has(id));
  const reachableEndings = reachable.filter((id) => endingById.get(id) === true);

  const errors: GraphValidationError[] = [];
  if (reachableEndings.length === 0) {
    errors.push(
      err('NO_REACHABLE_ENDING', 'No terminal ending scene is reachable from the start scene')
    );
  }

  return { reachable, unreachable, reachableEndings, errors };
}

/**
 * Blocking-error code for structural choice-reference validation.
 */
export type ChoiceReferenceErrorCode = 'DANGLING_TARGET';

export interface DanglingReference {
  code: ChoiceReferenceErrorCode;
  /** The choice carrying the dangling reference. */
  choiceId: string;
  /** The choice's source scene. */
  sceneId: string;
  /** The referenced scene that does not exist. */
  targetSceneId: string;
  message: string;
}

export interface ChoiceReferenceValidationResult {
  /**
   * Every choice whose target scene is missing from the provided scene set,
   * in input choice order. Empty means all structural references resolve.
   * Each entry is a blocking error per ADR-013 §5.
   */
  dangling: DanglingReference[];
}

/**
 * Structural choice-reference validator for publishing (Task E1b).
 *
 * Verifies that every choice's target scene exists in the provided scene
 * set (the world's scenes, as passed by the caller). Reports ALL dangling
 * references, not just the first, each identified by choice id, source
 * scene id, and the missing target scene id.
 *
 * Pure: no DB, no I/O, deterministic; does not mutate its inputs.
 * Condition/mutation semantic reference validation is explicitly out of
 * scope — conditions are opaque JSON until the G1 grammar lands
 * (Decision: Option A, ADR-013 §5).
 */
export function validateChoiceReferences(
  scenes: Scene[],
  choices: Choice[]
): ChoiceReferenceValidationResult {
  const sceneIds = new Set(scenes.map((s) => s.getSceneId().getValue()));
  const dangling: DanglingReference[] = [];

  for (const choice of choices) {
    const targetSceneId = choice.getTargetSceneId().getValue();
    if (!sceneIds.has(targetSceneId)) {
      const choiceId = choice.getChoiceId().getValue();
      const sceneId = choice.getSceneId().getValue();
      dangling.push({
        code: 'DANGLING_TARGET',
        choiceId,
        sceneId,
        targetSceneId,
        message:
          `Choice ${choiceId} in scene ${sceneId} ` +
          `references nonexistent target scene ${targetSceneId}`,
      });
    }
  }

  return { dangling };
}

export interface SemanticBlocker {
  code: string;
  choiceId: string;
  sceneId: string;
  payload: 'conditions' | 'mutations';
  message: string;
}

export interface ChoiceSemanticValidationResult {
  /**
   * Every choice with a semantic violation, in input choice order.
   * Empty means all choice grammars are valid. Each entry is a blocking
   * error per ADR-015 (G1c extends E1b).
   */
  blockers: SemanticBlocker[];
}

/**
 * Semantic choice validator for publishing (Task G1c, ADR-015).
 *
 * Validates every choice's conditions/mutations against the G1 grammar
 * (ADR-015 §2): unknown operators, malformed shapes, overlong/unsafe var
 * names, nesting beyond limits, non-finite literals, empty boolean arrays,
 * and `{}` conditions are all BLOCKERS. Absent `conditions` (unconditional)
 * and absent `mutations` (≡ []) are valid.
 *
 * Pure: no DB, no I/O, deterministic; does not mutate its inputs.
 * Additive to E1a/E1b — those functions are untouched.
 */
export function validateChoiceSemanticsForPublish(
  choices: Choice[]
): ChoiceSemanticValidationResult {
  const blockers: SemanticBlocker[] = [];
  for (const choice of choices) {
    const violations = validateChoiceSemantics(
      choice.getConditions(),
      choice.getMutations()
    );
    for (const v of violations) {
      blockers.push({
        code: v.code,
        choiceId: choice.getChoiceId().getValue(),
        sceneId: choice.getSceneId().getValue(),
        payload: v.payload,
        message: `Choice ${choice.getChoiceId().getValue()}: ${v.message}`,
      });
    }
  }
  return { blockers };
}
