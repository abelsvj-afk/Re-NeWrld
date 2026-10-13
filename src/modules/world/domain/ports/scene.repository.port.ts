import { Scene } from '../entities/scene.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';

/**
 * Read port for world scenes (Task E2a).
 *
 * Minimal by design: E2a only needs the world's full scene set for
 * validation and canon serialization. Scene write paths arrive with later
 * authoring phases and are deliberately not declared here.
 */
export interface SceneRepositoryPort {
  findByWorldId(worldId: WorldId): Promise<Scene[]>;
}
