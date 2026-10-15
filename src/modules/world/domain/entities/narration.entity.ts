import { WorldValidationError } from '../errors/world.errors.js';
import { SceneId } from '../value-objects/scene-id.value-object.js';
import { WorldId } from '../value-objects/world-id.value-object.js';

export interface NarrationProps {
  narrationId?: string;
  worldId: WorldId;
  canonVersion: number;
  sceneId: SceneId;
  proseHash: string;
  voiceId: string;
  modelId: string;
  audioPath: string;
  characterCount: number;
  createdAt?: Date;
}

/**
 * A cached TTS narration for one scene's prose.
 * Content-addressed: the prose_hash is sha256 of the exact prose text,
 * so any prose edit naturally produces a distinct narration row.
 * Rows for published canon versions are permanent.
 */
export class Narration {
  private readonly narrationId: string | null;
  private readonly worldId: WorldId;
  private readonly canonVersion: number;
  private readonly sceneId: SceneId;
  private readonly proseHash: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly audioPath: string;
  private readonly characterCount: number;
  private readonly createdAt: Date;

  private constructor(props: NarrationProps) {
    if (!/^[0-9a-f]{64}$/i.test(props.proseHash)) {
      throw new WorldValidationError('proseHash must be a sha256 hex string');
    }
    if (!props.voiceId || props.voiceId.trim().length === 0) {
      throw new WorldValidationError('voiceId cannot be empty');
    }
    if (!Number.isInteger(props.characterCount) || props.characterCount <= 0) {
      throw new WorldValidationError('characterCount must be a positive integer');
    }
    if (props.characterCount > 5000) {
      throw new WorldValidationError('characterCount exceeds per-scene narration cap (5000)');
    }

    this.narrationId = props.narrationId ?? null;
    this.worldId = props.worldId;
    this.canonVersion = props.canonVersion;
    this.sceneId = props.sceneId;
    this.proseHash = props.proseHash.toLowerCase();
    this.voiceId = props.voiceId.trim();
    this.modelId = props.modelId.trim() || 'eleven_turbo_v2_5';
    this.audioPath = props.audioPath;
    this.characterCount = props.characterCount;
    this.createdAt = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();
  }

  public static create(props: NarrationProps): Narration {
    return new Narration(props);
  }

  public getNarrationId(): string | null { return this.narrationId; }
  public getWorldId(): WorldId { return this.worldId; }
  public getCanonVersion(): number { return this.canonVersion; }
  public getSceneId(): SceneId { return this.sceneId; }
  public getProseHash(): string { return this.proseHash; }
  public getVoiceId(): string { return this.voiceId; }
  public getModelId(): string { return this.modelId; }
  public getAudioPath(): string { return this.audioPath; }
  public getCharacterCount(): number { return this.characterCount; }
  public getCreatedAt(): Date { return new Date(this.createdAt.getTime()); }
}
