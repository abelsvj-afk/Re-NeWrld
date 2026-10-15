import { Narration } from '../entities/narration.entity.js';
import { WorldId } from '../value-objects/world-id.value-object.js';
import { SceneId } from '../value-objects/scene-id.value-object.js';

export interface NarrationLookup {
  worldId: WorldId;
  canonVersion: number;
  sceneId: SceneId;
  proseHash: string;
  voiceId: string;
  modelId: string;
}

/**
 * Repository port for cached scene narrations.
 * The unique content-hash constraint makes concurrent generation safe:
 * only one row wins per (world, version, scene, hash, voice, model).
 */
export interface NarrationRepositoryPort {
  findCached(lookup: NarrationLookup): Promise<Narration | null>;
  /** Latest narration for this exact prose, any voice (reader serving). */
  findLatestByScene(worldId: WorldId, canonVersion: number, sceneId: SceneId, proseHash: string): Promise<Narration | null>;
  save(narration: Narration): Promise<Narration>;
  sumCharactersThisMonth(): Promise<number>;
}
