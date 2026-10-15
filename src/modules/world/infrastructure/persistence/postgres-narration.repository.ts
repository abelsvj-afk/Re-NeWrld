import { NarrationRepositoryPort, NarrationLookup } from '../../domain/ports/narration.repository.port.js';
import { Narration, NarrationProps } from '../../domain/entities/narration.entity.js';
import { WorldId } from '../../domain/value-objects/world-id.value-object.js';
import { SceneId } from '../../domain/value-objects/scene-id.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface NarrationRow {
  id: string;
  world_id: string;
  canon_version: number;
  scene_id: string;
  prose_hash: string;
  voice_id: string;
  model_id: string;
  audio_path: string;
  character_count: number;
  created_at: string | Date;
}

/**
 * Postgres adapter for cached scene narrations (ADR-016).
 * `save` uses ON CONFLICT DO NOTHING on the content-hash unique constraint
 * so concurrent first-generation attempts converge on a single row.
 */
export class PostgresNarrationRepository implements NarrationRepositoryPort {
  public async findCached(lookup: NarrationLookup): Promise<Narration | null> {
    const result = await query<NarrationRow>(
      `SELECT id, world_id, canon_version, scene_id, prose_hash, voice_id, model_id,
              audio_path, character_count, created_at
       FROM scene_narrations
       WHERE world_id = $1 AND canon_version = $2 AND scene_id = $3
         AND prose_hash = $4 AND voice_id = $5 AND model_id = $6`,
      [
        lookup.worldId.getValue(),
        lookup.canonVersion,
        lookup.sceneId.getValue(),
        lookup.proseHash.toLowerCase(),
        lookup.voiceId,
        lookup.modelId,
      ]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  public async findLatestByScene(
    worldId: WorldId, canonVersion: number, sceneId: SceneId, proseHash: string
  ): Promise<Narration | null> {
    const result = await query<NarrationRow>(
      `SELECT id, world_id, canon_version, scene_id, prose_hash, voice_id, model_id,
              audio_path, character_count, created_at
       FROM scene_narrations
       WHERE world_id = $1 AND canon_version = $2 AND scene_id = $3 AND prose_hash = $4
       ORDER BY created_at DESC LIMIT 1`,
      [worldId.getValue(), canonVersion, sceneId.getValue(), proseHash.toLowerCase()]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  public async save(narration: Narration): Promise<Narration> {
    const result = await query<NarrationRow>(
      `INSERT INTO scene_narrations
         (world_id, canon_version, scene_id, prose_hash, voice_id, model_id, audio_path, character_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (world_id, canon_version, scene_id, prose_hash, voice_id, model_id) DO NOTHING
       RETURNING id, world_id, canon_version, scene_id, prose_hash, voice_id, model_id,
                 audio_path, character_count, created_at`,
      [
        narration.getWorldId().getValue(),
        narration.getCanonVersion(),
        narration.getSceneId().getValue(),
        narration.getProseHash(),
        narration.getVoiceId(),
        narration.getModelId(),
        narration.getAudioPath(),
        narration.getCharacterCount(),
      ]
    );
    if (result.rows.length > 0) return this.mapRow(result.rows[0]);
    // Lost the race: another writer inserted first. Return the winner.
    const existing = await this.findCached({
      worldId: narration.getWorldId(),
      canonVersion: narration.getCanonVersion(),
      sceneId: narration.getSceneId(),
      proseHash: narration.getProseHash(),
      voiceId: narration.getVoiceId(),
      modelId: narration.getModelId(),
    });
    if (!existing) throw new Error('Narration save conflict could not be resolved');
    return existing;
  }

  public async sumCharactersThisMonth(): Promise<number> {
    const result = await query<{ total: string }>(
      `SELECT COALESCE(SUM(character_count), 0) AS total
       FROM scene_narrations
       WHERE created_at >= date_trunc('month', CURRENT_TIMESTAMP)`
    );
    return parseInt(result.rows[0]?.total ?? '0', 10);
  }

  private mapRow(row: NarrationRow): Narration {
    const props: NarrationProps = {
      narrationId: row.id,
      worldId: new WorldId(row.world_id),
      canonVersion: row.canon_version,
      sceneId: new SceneId(row.scene_id),
      proseHash: row.prose_hash,
      voiceId: row.voice_id,
      modelId: row.model_id,
      audioPath: row.audio_path,
      characterCount: row.character_count,
      createdAt: new Date(row.created_at),
    };
    return Narration.create(props);
  }
}
