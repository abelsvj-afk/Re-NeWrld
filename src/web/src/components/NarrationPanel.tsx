import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { worldsApi, ApiError } from '../lib/api';

interface NarrationPanelProps {
  worldId: string;
  sceneId: string;
  onGenerated?: () => void;
}

interface Voice { voiceId: string; name: string; }
interface Quota { usedThisMonth: number; monthlyCap: number; providerRemaining: number | null; configured: boolean; }

/**
 * Creator narration controls (ADR-016, T2).
 * Voice picker, per-scene generation, quota bar.
 */
export function NarrationPanel({ worldId, sceneId, onGenerated }: NarrationPanelProps) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [voiceId, setVoiceId] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState<'idle' | 'cached' | 'generated' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [v, q] = await Promise.all([
          worldsApi.narrationVoices(worldId).catch(() => [] as Voice[]),
          worldsApi.narrationQuota(worldId).catch(() => null),
        ]);
        if (!cancelled) {
          setVoices(v);
          if (v.length > 0 && !voiceId) setVoiceId(v[0].voiceId);
          setQuota(q);
          setVoicesLoading(false);
        }
      } catch { /* narration unavailable — panel stays hidden */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  useEffect(() => {
    setStatus('idle');
    setError(null);
  }, [sceneId]);

  if (quota && !quota.configured) return null;

  const generate = async () => {
    if (!voiceId || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await worldsApi.generateNarration(worldId, sceneId, { voiceId });
      setStatus(res.status);
      onGenerated?.();
      const q = await worldsApi.narrationQuota(worldId).catch(() => null);
      if (q) setQuota(q);
    } catch (err) {
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const pct = quota ? Math.min(100, (quota.usedThisMonth / quota.monthlyCap) * 100) : 0;

  return (
    <div className="mb-8 bg-panel/40 border border-edge/60 rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[11px] uppercase tracking-[0.25em] text-ink-faint font-semibold">🎧 Narration</h3>
        {status === 'cached' && <span className="text-[11px] text-arcane font-medium">✓ Cached — no credits used</span>}
        {status === 'generated' && <span className="text-[11px] text-ember font-medium">✓ Generated</span>}
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <select
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          aria-label="Narrator voice"
          className="flex-1 bg-abyss border border-edge rounded-xl px-4 py-2.5 text-sm text-ink focus:border-arcane focus:outline-none transition-all"
        >
          {voices.map((v) => (
            <option key={v.voiceId} value={v.voiceId}>{v.name}</option>
          ))}
          {voicesLoading && <option value="">Loading voices…</option>}
          {!voicesLoading && voices.length === 0 && <option value="">No voices available</option>}
        </select>
        <button
          onClick={generate}
          disabled={generating || !voiceId}
          className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-arcane to-[#0ea5c4] text-void text-sm font-semibold hover:brightness-110 disabled:opacity-50 transition-all shadow-glow-cyan whitespace-nowrap"
        >
          {generating ? 'Generating…' : 'Generate Narration'}
        </button>
      </div>

      <AnimatePresence>
        {error && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-blood text-xs mb-3">{error}</motion.p>
        )}
      </AnimatePresence>

      {quota && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[11px] text-ink-faint">Monthly quota</p>
            <p className="text-[11px] text-ink-faint font-mono tabular-nums">
              {quota.usedThisMonth.toLocaleString()} / {quota.monthlyCap.toLocaleString()}
              {quota.providerRemaining !== null && ` · ${quota.providerRemaining.toLocaleString()} left`}
            </p>
          </div>
          <div className="h-1.5 rounded-full bg-abyss overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${pct > 80 ? 'bg-blood' : 'bg-gradient-to-r from-arcane to-[#0ea5c4]'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      <p className="text-[11px] text-ink-faint mt-3">Audio is generated once per scene and cached forever — readers never spend credits.</p>
    </div>
  );
}
