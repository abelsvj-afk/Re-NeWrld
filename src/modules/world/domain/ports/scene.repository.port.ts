import { Scene } from '../entities/scene.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { SceneId } from '../value-objects/scene-id.value-object.js';

/**
 * Repository port for world scenes.
 *
 * Read paths from Task E2a; write paths added in Phase H (H1b) for the
 * creator scene editor.
 */
export interface SceneRepositoryPort {
  findByWorldId(worldId: WorldId): Promise<Scene[]>;
  findById(sceneId: SceneId): Promise<Scene | null>;
  save(scene: Scene): Promise<void>;
  delete(sceneId: SceneId): Promise<void>;
}
