import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

interface NarrationPlayerProps {
  audioUrl: string;
  sceneTitle: string;
}

/**
 * Dark-cinematic narration player (ADR-016, T2).
 * Play/pause with progress bar, time display, keyboard accessible.
 * Renders nothing until the audio metadata loads (no broken player state).
 */
export function NarrationPlayer({ audioUrl, sceneTitle }: NarrationPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setReady(false);
    setError(false);
  }, [audioUrl]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el || !ready) return;
    if (playing) el.pause();
    else el.play().catch(() => setError(true));
  };

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  if (error) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: ready ? 1 : 0, y: ready ? 0 : -8 }}
      transition={{ duration: 0.4 }}
      className="mb-8"
    >
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        onLoadedMetadata={() => { setReady(true); setDuration(audioRef.current?.duration ?? 0); }}
        onTimeUpdate={() => {
          const el = audioRef.current;
          if (el && el.duration) setProgress((el.currentTime / el.duration) * 100);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onError={() => setError(true)}
      />
      {ready && (
        <div className="flex items-center gap-4 bg-panel/60 border border-edge/60 rounded-2xl px-5 py-4 backdrop-blur-sm">
          <button
            onClick={toggle}
            aria-label={playing ? `Pause narration of ${sceneTitle}` : `Play narration of ${sceneTitle}`}
            className="w-11 h-11 shrink-0 rounded-full bg-gradient-to-br from-arcane to-[#0ea5c4] text-void flex items-center justify-center hover:brightness-110 transition-all shadow-glow-cyan"
          >
            {playing ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="1" width="4" height="14" rx="1" /><rect x="10" y="1" width="4" height="14" rx="1" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5v13l11-6.5z" /></svg>
            )}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] uppercase tracking-[0.2em] text-ink-faint font-medium">🎧 Narrated</p>
              <p className="text-[11px] text-ink-faint font-mono tabular-nums">{fmt((progress / 100) * duration)} / {fmt(duration)}</p>
            </div>
            <div
              role="slider"
              aria-label="Narration progress"
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              onKeyDown={(e) => {
                const el = audioRef.current;
                if (!el || !el.duration) return;
                if (e.key === 'ArrowRight') el.currentTime = Math.min(el.duration, el.currentTime + 10);
                if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 10);
              }}
              onClick={(e) => {
                const el = audioRef.current;
                const bar = e.currentTarget;
                if (!el || !el.duration) return;
                const rect = bar.getBoundingClientRect();
                el.currentTime = ((e.clientX - rect.left) / rect.width) * el.duration;
              }}
              className="h-1.5 rounded-full bg-abyss cursor-pointer group"
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-arcane to-[#0ea5c4] transition-[width] duration-150 group-hover:brightness-125"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
