import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { Narration, NarrationProps } from '../domain/entities/narration.entity.js';
import { NarrationRepositoryPort } from '../domain/ports/narration.repository.port.js';
import { SceneRepositoryPort } from '../domain/ports/scene.repository.port.js';
import { WorldRepositoryPort } from '../domain/ports/world.repository.port.js';
import { WorldId } from '../domain/value-objects/world-id.value-object.js';
import { SceneId } from '../domain/value-objects/scene-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { WorldNotFoundError, WorldValidationError } from '../domain/errors/world.errors.js';
import { ElevenLabsClient, proseToPlainText, sha256Hex } from '../infrastructure/elevenlabs.client.js';

export interface GenerateNarrationInput {
  worldId: string;
  sceneId: string;
  creatorId: UserId;
  voiceId: string;
  modelId?: string;
}

export interface GenerateNarrationOutput {
  status: 'cached' | 'generated';
  audioPath: string;
  characterCount: number;
}

export interface NarrationServiceDeps {
  narrationRepository: NarrationRepositoryPort;
  sceneRepository: SceneRepositoryPort;
  worldRepository: WorldRepositoryPort;
  elevenLabs: ElevenLabsClient | null;
  storagePath: string;
  monthlyCharCap: number;
}

/**
 * Generate (or fetch cached) TTS narration for a scene (ADR-016, T1).
 * Creator-only. Content-addressed: identical prose + voice + model
 * always resolves to the same cached audio — generation happens once,
 * globally, ever. Quota gates from the System Completeness Gate §8.
 */
export class GenerateNarrationUseCase {
  constructor(private readonly deps: NarrationServiceDeps) {}

  public async execute(input: GenerateNarrationInput): Promise<GenerateNarrationOutput> {
    const worldId = new WorldId(input.worldId);
    const sceneId = new SceneId(input.sceneId);
    const creatorId = input.creatorId;

    const world = await this.deps.worldRepository.findById(worldId);
    if (!world || !world.getCreatorId().equals(creatorId)) {
      throw new WorldNotFoundError(input.worldId);
    }
    const scene = await this.deps.sceneRepository.findById(sceneId);
    if (!scene || !scene.getWorldId().equals(worldId)) {
      throw new WorldValidationError('Scene must belong to this world');
    }
    if (!this.deps.elevenLabs) {
      throw new WorldValidationError('Narration is not configured (ELEVENLABS_API_KEY unset)');
    }

    const plainText = proseToPlainText(scene.getProse());
    if (plainText.length === 0) {
      throw new WorldValidationError('Scene has no narratable text');
    }
    if (plainText.length > 5000) {
      throw new WorldValidationError('Scene exceeds per-scene narration cap (5000 characters)');
    }

    const proseHash = sha256Hex(plainText);
    const modelId = input.modelId ?? 'eleven_turbo_v2_5';
    // v1: draft worlds use canon version 0; published versions pin their own.
    const canonVersion = 0;

    const cached = await this.deps.narrationRepository.findCached({
      worldId, canonVersion, sceneId, proseHash,
      voiceId: input.voiceId, modelId,
    });
    if (cached) {
      return { status: 'cached', audioPath: cached.getAudioPath(), characterCount: cached.getCharacterCount() };
    }

    // Quota gates (completeness gate §8): monthly ledger + live provider check.
    const usedThisMonth = await this.deps.narrationRepository.sumCharactersThisMonth();
    if (usedThisMonth + plainText.length > this.deps.monthlyCharCap) {
      throw new WorldValidationError('Monthly narration quota exhausted');
    }
    const remaining = await this.deps.elevenLabs.getRemainingQuota();
    if (remaining !== null && remaining < plainText.length) {
      throw new WorldValidationError('ElevenLabs quota insufficient for this scene');
    }

    const audio = await this.deps.elevenLabs.synthesize(input.voiceId, plainText);

    const audioPath = join(this.deps.storagePath, `${worldId.getValue()}_${sceneId.getValue()}_${proseHash.slice(0, 16)}.mp3`);
    await mkdir(this.deps.storagePath, { recursive: true });
    await writeFile(audioPath, audio);

    const props: NarrationProps = {
      worldId, canonVersion, sceneId, proseHash,
      voiceId: input.voiceId, modelId, audioPath,
      characterCount: plainText.length,
    };
    const saved = await this.deps.narrationRepository.save(Narration.create(props));
    return { status: 'generated', audioPath: saved.getAudioPath(), characterCount: saved.getCharacterCount() };
  }
}
