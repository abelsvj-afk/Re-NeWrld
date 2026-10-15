import { useState, useEffect } from 'react';
import { useParams } from '@tanstack/react-router';
import { motion, AnimatePresence } from 'framer-motion';
import { worldsApi, ApiError } from '../lib/api';

type Step = 'idle' | 'validating' | 'review' | 'publishing' | 'done' | 'failed';

interface ValidationResult {
  passed: boolean;
  warnings: string[];
  blockers: string[];
}

export function PublishPage() {
  const { worldId } = useParams({ strict: false }) as { worldId: string };
  const [step, setStep] = useState<Step>('idle');
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [publishResult, setPublishResult] = useState<{ versionNumber: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<{ scenes: number; choices: number; endings: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [scenes, choices] = await Promise.all([
          worldsApi.scenes(worldId),
          worldsApi.choices(worldId),
        ]);
        setChecklist({
          scenes: scenes.length,
          choices: choices.length,
          endings: scenes.filter((s) => s.isEnding).length,
        });
      } catch { /* checklist is best-effort */ }
    })();
  }, [worldId]);

  const runValidation = async () => {
    setStep('validating');
    setError(null);
    // Validation happens server-side during publish; we do a dry check
    // by attempting publish and catching validation errors.
    // For MVP, validation and publish are one step.
    await publish();
  };

  const publish = async () => {
    setStep('publishing');
    setError(null);
    try {
      const res = await worldsApi.publish(worldId);
      setPublishResult({ versionNumber: res.versionNumber });
      setResult({ passed: true, warnings: res.warnings, blockers: [] });
      setStep('done');
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        // PublishingValidationError — parse blockers from message
        setResult({ passed: false, warnings: [], blockers: [err.message] });
        setStep('failed');
      } else {
        setError(err instanceof ApiError ? err.message : 'Publish failed');
        setStep('idle');
      }
    }
  };

  return (
    <div className="min-h-screen bg-void">
      <header className="border-b border-edge bg-abyss/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <h1 className="text-lg font-semibold">Publishing & Validation</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        <AnimatePresence mode="wait">
          {step === 'idle' && (
            <motion.div
              key="idle"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="glass rounded-2xl p-10 text-center"
            >
              <div className="w-20 h-20 mx-auto mb-6 rounded-full border-2 border-edge flex items-center justify-center">
                <span className="text-3xl">🚀</span>
              </div>
              <h2 className="text-2xl font-semibold mb-3">Ready to publish?</h2>
              <p className="text-ink-dim mb-8 max-w-md mx-auto">
                Publishing validates your world graph — checking scene targets,
                ending reachability, and condition references. Invalid worlds
                are rejected; valid worlds become immutable snapshots.
              </p>
              {checklist && (
                <div className="max-w-sm mx-auto mb-8 text-left space-y-2">
                  <ChecklistItem ok={checklist.scenes > 0} label={`At least 1 scene (${checklist.scenes})`} />
                  <ChecklistItem ok={checklist.choices > 0} label={`At least 1 choice (${checklist.choices})`} />
                  <ChecklistItem ok={checklist.endings > 0} label={`At least 1 ending (${checklist.endings})`} />
                </div>
              )}
              <button
                onClick={runValidation}
                className="bg-arcane text-void font-semibold rounded-xl px-8 py-3.5 hover:bg-arcane/90 transition shadow-glow-cyan"
              >
                Validate & Publish
              </button>
              {error && <p className="text-blood mt-4">{error}</p>}
            </motion.div>
          )}

          {(step === 'validating' || step === 'publishing') && (
            <motion.div
              key="working"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="glass rounded-2xl p-10 text-center"
            >
              <div className="w-20 h-20 mx-auto mb-6 rounded-full border-2 border-arcane border-t-transparent animate-spin" />
              <p className="text-ink-dim">
                {step === 'validating' ? 'Validating world graph…' : 'Publishing snapshot…'}
              </p>
            </motion.div>
          )}

          {step === 'done' && result?.passed && (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className="glass rounded-2xl p-10 text-center border-emerald-400/30"
            >
              <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-emerald-400/15 border-2 border-emerald-400/50 flex items-center justify-center">
                <span className="text-3xl text-emerald-300">✓</span>
              </div>
              <h2 className="text-2xl font-semibold mb-2 text-emerald-300">
                Published
              </h2>
              <p className="text-ink-dim mb-6">
                Version {publishResult?.versionNumber} is now live for readers.
              </p>
              {result.warnings.length > 0 && (
                <div className="text-left bg-ember/10 border border-ember/20 rounded-xl p-5 mb-6">
                  <h3 className="text-sm font-semibold text-ember mb-2">
                    Warnings ({result.warnings.length})
                  </h3>
                  <ul className="text-sm text-ink-dim space-y-1">
                    {result.warnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </motion.div>
          )}

          {step === 'failed' && result && (
            <motion.div
              key="failed"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass rounded-2xl p-10 border-blood/30"
            >
              <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-blood/10 border-2 border-blood/40 flex items-center justify-center">
                <span className="text-3xl text-blood">✕</span>
              </div>
              <h2 className="text-2xl font-semibold mb-2 text-blood text-center">
                Validation Failed
              </h2>
              <p className="text-ink-dim text-center mb-6">
                Fix the issues below and try again.
              </p>
              <div className="bg-blood/10 border border-blood/20 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-blood mb-2">
                  Blockers ({result.blockers.length})
                </h3>
                <ul className="text-sm text-ink-dim space-y-1">
                  {result.blockers.map((b, i) => (
                    <li key={i}>• {b}</li>
                  ))}
                </ul>
              </div>
              <button
                onClick={() => setStep('idle')}
                className="mt-6 w-full border border-edge rounded-xl px-6 py-3 text-sm hover:border-arcane/50 hover:text-arcane transition"
              >
                Back to Editor
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function ChecklistItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border text-sm ${ok ? 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300' : 'border-blood/25 bg-blood/[0.06] text-blood'}`}>
      <span className="text-base">{ok ? '✓' : '✕'}</span>
      <span>{label}</span>
    </div>
  );
}
