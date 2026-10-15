import { createHash } from 'crypto';

export interface VoiceSummary {
  voiceId: string;
  name: string;
}

/**
 * Minimal ElevenLabs TTS client (ADR-016).
 * Server-side only: the API key never leaves this service.
 * Includes the circuit breaker mandated by the System Completeness Gate §8:
 * after 3 consecutive failures, synthesis is refused until a success resets it.
 */
export interface ElevenLabsConfig {
  apiKey: string;
  modelId?: string;
  timeoutMs?: number;
}

export class ElevenLabsClient {
  private consecutiveFailures = 0;
  private readonly maxFailures = 3;
  private readonly modelId: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ElevenLabsConfig) {
    this.modelId = config.modelId ?? 'eleven_turbo_v2_5';
    this.timeoutMs = config.timeoutMs ?? 120000;
  }

  public isCircuitOpen(): boolean {
    return this.consecutiveFailures >= this.maxFailures;
  }

  /**
   * Fetch the account's remaining character quota.
   * Returns null when the check itself fails (fail-open: generation proceeds,
   * ElevenLabs will 402 if quota is truly exhausted).
   */
  public async getRemainingQuota(): Promise<number | null> {
    try {
      const res = await this.request('GET', '/v1/user');
      const sub = (res as any)?.subscription;
      if (typeof sub?.character_limit === 'number' && typeof sub?.character_count === 'number') {
        return Math.max(0, sub.character_limit - sub.character_count);
      }
      return null;
    } catch {
      return null;
    }
  }

  public async listVoices(): Promise<VoiceSummary[]> {
    const res = await this.request('GET', '/v1/voices');
    const voices = (res as any)?.voices;
    if (!Array.isArray(voices)) return [];
    return voices.map((v: any) => ({
      voiceId: String(v.voice_id ?? ''),
      name: String(v.name ?? 'Unnamed'),
    })).filter((v: VoiceSummary) => v.voiceId.length > 0);
  }

  public async synthesize(voiceId: string, text: string): Promise<Buffer> {
    if (this.isCircuitOpen()) {
      throw new Error('ElevenLabs circuit breaker open: synthesis temporarily unavailable');
    }
    if (!text || text.trim().length === 0) {
      throw new Error('Cannot synthesize empty text');
    }
    try {
      const audio = await this.requestBuffer(
        'POST',
        `/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        { text: text.trim(), model_id: this.modelId },
        { Accept: 'audio/mpeg' }
      );
      this.consecutiveFailures = 0;
      return audio;
    } catch (err) {
      this.consecutiveFailures += 1;
      throw err;
    }
  }

  private async request(method: string, path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`https://api.elevenlabs.io${path}`, {
        method,
        headers: { 'xi-api-key': this.config.apiKey },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ElevenLabs ${method} ${path}: ${res.status}`);
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestBuffer(
    method: string,
    path: string,
    body: unknown,
    extraHeaders: Record<string, string>
  ): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`https://api.elevenlabs.io${path}`, {
        method,
        headers: {
          'xi-api-key': this.config.apiKey,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`ElevenLabs ${method} ${path}: ${res.status} ${detail.slice(0, 200)}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Strip HTML tags for TTS input; prose is stored as TipTap HTML. */
export function proseToPlainText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
