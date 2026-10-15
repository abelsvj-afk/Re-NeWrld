import { readFile, stat } from 'fs/promises';
import { NarrationRepositoryPort } from '../domain/ports/narration.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { sha256Hex, proseToPlainText } from '../infrastructure/elevenlabs.client.js';

export interface GetNarrationOutput {
  found: boolean;
  audio?: Buffer;
  voiceId?: string;
}

/**
 * Serve cached narration audio for a scene (ADR-016, T1).
 * Readers never trigger generation or spend quota: cache hit → audio,
 * cache miss → not-found (creator generates explicitly).
 */
export class GetNarrationUseCase {
  constructor(
    private readonly narrationRepository: NarrationRepositoryPort,
    private readonly sceneRepository: SceneRepositoryPort,
    private readonly worldRepository: WorldRepositoryPort,
  ) {}

  public async execute(worldIdRaw: string, sceneIdRaw: string): Promise<GetNarrationOutput> {
    const worldId = new WorldId(worldIdRaw);
    const sceneId = new SceneId(sceneIdRaw);

    const world = await this.worldRepository.findById(worldId);
    if (!world) return { found: false };
    // Only published worlds serve narration to readers.
    if (world.getStatus().getValue() !== 'published') return { found: false };

    const scene = await this.sceneRepository.findById(sceneId);
    if (!scene || !scene.getWorldId().equals(worldId)) return { found: false };

    const proseHash = sha256Hex(proseToPlainText(scene.getProse()));
    const cached = await this.narrationRepository.findLatestByScene(worldId, 0, sceneId, proseHash);

    if (!cached) return { found: false };
    try {
      await stat(cached.getAudioPath());
      const audio = await readFile(cached.getAudioPath());
      return { found: true, audio, voiceId: cached.getVoiceId() };
    } catch {
      return { found: false };
    }
  }
}
