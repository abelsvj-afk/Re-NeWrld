import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { ChoiceRepositoryPort } from '../domain/ports/choice.repository.port.js';
import { WorldVariableRepositoryPort } from '../domain/ports/world-variable.repository.port.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError } from '../domain/errors/world.errors.js';
import {
  validateWorldGraph,
  validateChoiceReferences,
  validateChoiceSemanticsForPublish,
} from '../domain/services/graph-validator.js';

export interface ValidateWorldCommand {
  worldId: WorldId;
  creatorId: UserId;
}

export interface ValidateWorldResult {
  valid: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * Dry-run publishing validation (H-UX4). Runs the same checks as publish
 * without creating a snapshot. Lets creators verify before committing.
 */
export class ValidateWorldUseCase {
  constructor(
    private readonly worlds: WorldRepositoryPort,
    private readonly scenes: SceneRepositoryPort,
    private readonly choices: ChoiceRepositoryPort,
    private readonly variables?: WorldVariableRepositoryPort,
  ) {}

  public async execute(command: ValidateWorldCommand): Promise<ValidateWorldResult> {
    const world = await this.worlds.findById(command.worldId);
    if (world === null || !world.getCreatorId().equals(command.creatorId)) {
      throw new WorldNotFoundError();
    }

    const [scenes, choices] = await Promise.all([
      this.scenes.findByWorldId(world.getWorldId()),
      this.choices.findByWorldId(world.getWorldId()),
    ]);

    const graph = validateWorldGraph(world, scenes, choices);
    const refs = validateChoiceReferences(scenes, choices);
    const semantics = validateChoiceSemanticsForPublish(choices);

    const toMessage = (b: { message?: string } | string): string =>
      typeof b === 'string' ? b : b.message ?? JSON.stringify(b);
    const blockers = [...graph.errors, ...refs.dangling, ...semantics.blockers].map(toMessage);

    // Match publish-world.use-case.ts: warn on unregistered variable references
    const variableWarnings: string[] = [];
    if (this.variables) {
      const registered = await this.variables.findByWorldId(world.getWorldId());
      const registeredNames = new Set(registered.map((v) => v.getName()));
      const referencedNames = new Set<string>();
      for (const choice of choices) {
        for (const name of extractVariableNames(choice.getConditions())) {
          referencedNames.add(name);
        }
        for (const name of extractVariableNames(choice.getMutations())) {
          referencedNames.add(name);
        }
      }
      for (const name of referencedNames) {
        if (!registeredNames.has(name)) {
          variableWarnings.push(`Variable "${name}" is used in conditions/mutations but not registered in the variable registry`);
        }
      }
    }

    return {
      valid: blockers.length === 0,
      blockers,
      warnings: [...graph.unreachable, ...variableWarnings],
    };
  }
}

/**
 * Recursively extract variable names from condition/mutation payloads.
 * Duplicated from publish-world.use-case.ts — keep in sync.
 */
function extractVariableNames(payload: unknown): string[] {
  const names: string[] = [];
  function walk(node: unknown): void {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.var === 'string') {
        names.push(obj.var);
      }
      for (const value of Object.values(obj)) {
        walk(value);
      }
    }
  }
  walk(payload);
  return names;
}
