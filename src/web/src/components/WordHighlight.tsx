import { useEffect, useState } from 'react';

interface WordTiming {
  word: string;
  start: number;
  end: number;
}

interface WordHighlightProps {
  text: string;
  wordsUrl: string;
  audioRef: React.RefObject<HTMLAudioElement | null>;
}

/**
 * Word-by-word highlighting synced to narration audio.
 * Fetches word timings from the backend and highlights the current word
 * based on the audio element's currentTime.
 */
export function WordHighlight({ text, wordsUrl, audioRef }: WordHighlightProps) {
  const [timings, setTimings] = useState<WordTiming[] | null>(null);
  const [currentWordIndex, setCurrentWordIndex] = useState(-1);

  useEffect(() => {
    let cancelled = false;
    fetch(wordsUrl, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data)) setTimings(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wordsUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !timings) return;

    const onTimeUpdate = () => {
      const t = audio.currentTime;
      // Find the word whose time range contains t
      let idx = -1;
      for (let i = 0; i < timings.length; i++) {
        if (t >= timings[i].start && t <= timings[i].end) {
          idx = i;
          break;
        }
        if (t < timings[i].start) break;
      }
      setCurrentWordIndex(idx);
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    return () => audio.removeEventListener('timeupdate', onTimeUpdate);
  }, [audioRef, timings]);

  if (!timings) {
    // Fallback: plain text without highlighting
    return <div className="prose-reading mb-12 whitespace-pre-wrap">{text}</div>;
  }

  // Split text into words and match with timings
  // Note: timings words should align with text.split(/\s+/)
  return (
    <div className="prose-reading mb-12 whitespace-pre-wrap leading-relaxed">
      {timings.map((tw, i) => (
        <span
          key={i}
          className={
            i === currentWordIndex
              ? 'bg-arcane/30 text-ink rounded px-0.5 transition-colors'
              : i < currentWordIndex
                ? 'text-ink-dim'
                : 'text-ink'
          }
        >
          {tw.word}
          {i < timings.length - 1 ? ' ' : ''}
        </span>
      ))}
    </div>
  );
}
