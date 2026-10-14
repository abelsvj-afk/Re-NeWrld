import { useEffect, useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { motion, AnimatePresence } from 'framer-motion';
import { sessionsApi, worldsApi, ApiError, type SessionState, type WorldSummary } from '../lib/api';
import { useAuth } from '../stores/auth';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function ReaderPage() {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [session, setSession] = useState<SessionState | null>(null);
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (sessionId) {
          const s = await sessionsApi.get(sessionId);
          setSession(s);
        } else {
          try {
            const w = await worldsApi.list();
            setWorlds(w.filter((x) => x.status === 'published'));
          } catch (err) {
            // 403 means reader can't list worlds (backend limitation) — show empty state
            if (err instanceof ApiError && err.status === 403) {
              setWorlds([]);
            } else {
              throw err;
            }
          }
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  const startWorld = async (worldId: string) => {
    setError(null);
    try {
      const s = await sessionsApi.start(worldId);
      navigate({ to: '/read/$sessionId', params: { sessionId: s.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start session');
    }
  };

  const choose = async (choiceId: string) => {
    if (!session || choosing) return;
    setChoosing(choiceId);
    setError(null);
    try {
      const next = await sessionsApi.choose(
        session.id,
        choiceId,
        session.version,
        newIdempotencyKey(),
      );
      setSession(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Version conflict — refresh and let the reader retry
        const fresh = await sessionsApi.get(session.id);
        setSession(fresh);
        setError('The story moved on — please choose again.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Choice failed');
      }
    } finally {
      setChoosing(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center">
        <div className="text-ink-dim animate-pulse">Opening the book…</div>
      </div>
    );
  }

  // World picker
  if (!session) {
    return (
      <div className="min-h-screen bg-void">
        <header className="border-b border-edge bg-abyss/80 backdrop-blur sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <h1 className="text-xl font-bold tracking-tight">
              Re<span className="text-arcane">:</span>NeWrld
            </h1>
            <button onClick={logout} className="text-sm text-ink-dim hover:text-ink transition">
              Sign out
            </button>
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-6 py-10">
          <h2 className="text-2xl font-semibold mb-2">Choose your story</h2>
          <p className="text-ink-dim mb-8">Published worlds await your choices.</p>
          {error && <p className="text-blood mb-4">{error}</p>}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {worlds.map((w) => (
              <button
                key={w.id}
                onClick={() => startWorld(w.id)}
                className="glass rounded-xl p-6 text-left hover:border-arcane/50 hover:shadow-glow-cyan transition group"
              >
                <h3 className="text-lg font-semibold group-hover:text-arcane transition mb-2">
                  {w.title}
                </h3>
                <p className="text-sm text-ink-dim line-clamp-3">{w.description}</p>
              </button>
            ))}
            {worlds.length === 0 && (
              <p className="text-ink-faint col-span-full">No published worlds yet.</p>
            )}
          </div>
        </main>
      </div>
    );
  }

  // Reading view
  return (
    <div className="min-h-screen bg-void">
      <header className="border-b border-edge bg-abyss/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <button
            onClick={() => navigate({ to: '/read' })}
            className="text-sm text-ink-dim hover:text-arcane transition"
          >
            ← Library
          </button>
          <button onClick={logout} className="text-sm text-ink-dim hover:text-ink transition">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          <motion.article
            key={session.currentSceneId + session.version}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
          >
            <div className="prose-reading whitespace-pre-wrap mb-12">{session.sceneText}</div>

            {error && (
              <p className="text-ember text-sm bg-ember/10 border border-ember/20 rounded-lg px-4 py-3 mb-6">
                {error}
              </p>
            )}

            <div className="space-y-3">
              {session.choices.map((c, i) => (
                <motion.button
                  key={c.id}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 + i * 0.07 }}
                  onClick={() => choose(c.id)}
                  disabled={!c.available || choosing !== null}
                  className={`w-full text-left rounded-xl px-6 py-4 border transition ${
                    c.available
                      ? 'glass hover:border-arcane/60 hover:shadow-glow-cyan cursor-pointer'
                      : 'bg-abyss border-edge opacity-45 cursor-not-allowed'
                  }`}
                >
                  <span className="text-arcane/80 text-xs font-mono mr-3">{i + 1}</span>
                  <span className={c.available ? 'text-ink' : 'text-ink-faint line-through'}>
                    {c.text}
                  </span>
                  {!c.available && c.unavailableReason && (
                    <span className="block text-xs text-ink-faint mt-1 ml-7">
                      {c.unavailableReason}
                    </span>
                  )}
                  {choosing === c.id && (
                    <span className="ml-3 text-arcane animate-pulse">…</span>
                  )}
                </motion.button>
              ))}
              {session.choices.length === 0 && (
                <p className="text-center text-ink-faint italic py-8">— The End —</p>
              )}
            </div>
          </motion.article>
        </AnimatePresence>
      </main>
    </div>
  );
}
