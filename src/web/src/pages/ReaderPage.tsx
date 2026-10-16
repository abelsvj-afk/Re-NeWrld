import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { sessionsApi, worldsApi, ApiError, WORLD_GENRES, type SessionState, type PublishedWorld } from '../lib/api';
import { useAuth } from '../stores/auth';
import { ViewToggle } from '../components/ViewToggle';
import { NarrationPlayer } from '../components/NarrationPlayer';
import { WordHighlight } from '../components/WordHighlight';
import { useParams, useNavigate } from '@tanstack/react-router';

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // RFC 4122 UUIDv4 fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function ReaderPage() {
  const { logout, user, becomeCreator } = useAuth();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const navigate = useNavigate();
  const sessionId = params.sessionId;

  const [catalog, setCatalog] = useState<PublishedWorld[]>([]);
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [session, setSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const narrationAudioRef = useRef<HTMLAudioElement | null>(null);
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);
  const [showWelcomeToast, setShowWelcomeToast] = useState(false);
  const [showInventory, setShowInventory] = useState(false);
  const [inventoryTab, setInventoryTab] = useState<'stats' | 'inventory' | 'relationships'>('stats');
  const [toasts, setToasts] = useState<Array<{ id: string; text: string }>>([]);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Array<{ id: string; chapterTitle: string; createdAt: string }>>([]);
  const [rewinding, setRewinding] = useState(false);

  const handleBecomeCreator = async () => {
    if (upgrading) return;
    if (!confirmUpgrade) {
      setConfirmUpgrade(true);
      // Auto-disarm after 5s so a stray tap doesn't linger.
      setTimeout(() => setConfirmUpgrade(false), 5000);
      return;
    }
    setUpgrading(true);
    setError(null);
    try {
      await becomeCreator();
      setShowWelcomeToast(true);
      // Let the toast land before entering the studio.
      await new Promise((r) => setTimeout(r, 1600));
      navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upgrade failed');
    } finally {
      setUpgrading(false);
      setConfirmUpgrade(false);
    }
  };

  const becomeCreatorButton = user?.role === 'reader' ? (
    <button
      onClick={handleBecomeCreator}
      disabled={upgrading}
      className={`text-xs font-medium px-3 py-2 rounded-lg transition ${
        confirmUpgrade
          ? 'bg-blood/20 border border-blood/50 text-blood hover:bg-blood/30'
          : 'bg-gradient-to-r from-arcane to-[#0ea5c4] text-void hover:brightness-110'
      } disabled:opacity-50`}
    >
      {upgrading ? 'Upgrading…' : confirmUpgrade ? 'Tap again to confirm' : '✦ Become a Creator'}
    </button>
  ) : null;

  // Single catalog effect: initial load + filter/search changes.
  // Search is debounced (400ms); genre changes fetch immediately.
  useEffect(() => {
    if (sessionId) {
      (async () => {
        setLoading(true);
        setError(null);
        try {
          setSession(await sessionsApi.get(sessionId));
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Failed to load');
        } finally {
          setLoading(false);
        }
      })();
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const w = await worldsApi.listPublished({
          genre: genreFilter ?? undefined,
          search: searchQuery.trim() || undefined,
        });
        setCatalog(w);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    }, searchQuery ? 400 : 0);
    return () => clearTimeout(t);
  }, [sessionId, genreFilter, searchQuery]);

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
      const next = await sessionsApi.choose(session.id, choiceId, session.version, newIdempotencyKey());
      setSession(next);
      // Show consequence cue toasts for applied mutations (Item F)
      if (next.mutationsApplied && next.mutationsApplied.length > 0) {
        const newToasts = next.mutationsApplied.map((m) => ({
          id: `${Date.now()}-${m.variable}`,
          text: m.displayText,
        }));
        setToasts((prev) => [...prev, ...newToasts]);
        // Auto-dismiss after 4s
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => !newToasts.some((nt) => nt.id === t.id)));
        }, 4000);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const fresh = await sessionsApi.get(session.id);
        setSession(fresh);
        setError('The story moved on — please choose again.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to choose');
      }
    } finally {
      setChoosing(null);
    }
  };

  const rewindTo = async (checkpointId: string) => {
    if (!session || rewinding) return;
    if (!window.confirm('Rewind to this checkpoint? Your current progress will branch — the original path is preserved.')) return;
    setRewinding(true);
    setError(null);
    try {
      await sessionsApi.rewind(session.id, checkpointId);
      const fresh = await sessionsApi.get(session.id);
      setSession(fresh);
      setShowCheckpoints(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rewind');
    } finally {
      setRewinding(false);
    }
  };

  // Reading view
  if (sessionId) {
    return (
      <div className="min-h-screen bg-void">
        <header className="sticky top-0 z-10 bg-void/85 backdrop-blur-xl border-b border-edge/70">
          <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
            <button onClick={() => navigate({ to: '/read' })} className="text-sm text-ink-dim hover:text-arcane transition flex items-center gap-2">
              <span>←</span> Library
            </button>
            <div className="flex items-center gap-3">
              {session && (
                <button onClick={() => setShowInventory(true)} className="text-sm text-ink-dim hover:text-arcane transition flex items-center gap-2" title="Character sheet & inventory" aria-label="Open character sheet">
                  <span>🎒</span>
                </button>
              )}
              {session && (
                <button onClick={async () => { try { setCheckpoints(await sessionsApi.checkpoints(session.id)); } catch { setCheckpoints([]); } setShowCheckpoints(true); }} className="text-sm text-ink-dim hover:text-arcane transition flex items-center gap-2" title="Chapter checkpoints" aria-label="Open checkpoints">
                  <span>📍</span>
                </button>
              )}
              <ViewToggle current="reader" />
              {becomeCreatorButton}
              <button onClick={logout} className="text-xs text-ink-faint hover:text-blood transition">Sign out</button>
            </div>
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-6 py-12">
          {loading && <div className="space-y-4 animate-pulse"><div className="h-4 bg-edge/40 rounded w-full" /><div className="h-4 bg-edge/40 rounded w-5/6" /><div className="h-4 bg-edge/40 rounded w-4/6" /></div>}
          {error && <div className="bg-blood/10 border border-blood/25 rounded-xl p-4 text-blood text-sm mb-6">{error}</div>}
          {session && (
            <AnimatePresence mode="wait">
              <motion.article key={session.currentSceneId + '-' + session.version} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
                <NarrationPlayer
                  audioUrl={worldsApi.narrationAudioUrl(session.worldId, session.currentSceneId)}
                  sceneTitle={session.sceneText.slice(0, 40)}
                  audioRef={narrationAudioRef}
                />
                {(session.sceneMetadata?.illustrationUrl as string | undefined) && (
                  <img
                    src={session.sceneMetadata.illustrationUrl as string}
                    alt="Scene illustration"
                    className="w-full max-h-80 object-cover rounded-2xl border border-edge/60 mb-8 shadow-panel"
                  />
                )}
                <WordHighlight
                  text={session.sceneText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}
                  wordsUrl={worldsApi.narrationWordsUrl(session.worldId, session.currentSceneId)}
                  audioRef={narrationAudioRef}
                />
                <div className="space-y-3">
                  <p className="text-[11px] uppercase tracking-[0.25em] text-ink-faint font-medium mb-4">Choose your path</p>
                  {session.choices.map((c, i) => (
                    <motion.button key={c.id} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.08 }} onClick={() => !c.locked && choose(c.id)} disabled={choosing !== null || c.locked}
                      aria-disabled={c.locked}
                      className={`w-full text-left group relative rounded-2xl p-5 transition-all overflow-hidden ${c.locked ? 'bg-panel/30 border border-edge/40 cursor-not-allowed opacity-60' : 'bg-panel/60 border border-edge/70 hover:border-arcane/40 hover:bg-panel disabled:opacity-50 disabled:cursor-wait'}`}>
                      <div className={`absolute inset-0 bg-gradient-to-r from-arcane/[0.06] to-transparent opacity-0 ${!c.locked && 'group-hover:opacity-100'} transition-opacity pointer-events-none`} />
                      <div className="relative flex items-center gap-4">
                        <span className={`w-8 h-8 rounded-lg border text-sm font-semibold flex items-center justify-center shrink-0 ${c.locked ? 'bg-edge/20 border-edge/30 text-ink-faint' : 'bg-arcane/10 border-arcane/20 text-arcane'}`}>{c.locked ? '🔒' : i + 1}</span>
                        <span className="flex-1">
                          <span className="block text-[15px] leading-relaxed">{c.text}</span>
                          {c.locked && c.lockReason && <span className="block text-xs text-ink-faint mt-1">🔒 {c.lockReason}</span>}
                        </span>
                        {choosing === c.id && <span className="w-4 h-4 border-2 border-arcane/30 border-t-arcane rounded-full animate-spin shrink-0" />}
                      </div>
                    </motion.button>
                  ))}
                </div>
              </motion.article>
            </AnimatePresence>
          )}
        </main>
        <CreatorWelcomeToast show={showWelcomeToast} />

        {/* Checkpoints Modal */}
        <AnimatePresence>
          {showCheckpoints && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setShowCheckpoints(false)}>
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-panel border border-edge rounded-2xl p-8 shadow-panel" role="dialog" aria-label="Chapter checkpoints">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="font-prose text-2xl">Checkpoints</h3>
                  <button onClick={() => setShowCheckpoints(false)} className="text-ink-faint hover:text-ink text-xl" aria-label="Close">✕</button>
                </div>
                {checkpoints.length === 0 ? (
                  <p className="text-ink-faint text-sm text-center py-8">No checkpoints yet.<br />Checkpoints are created automatically at chapter boundaries.</p>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {checkpoints.map((cp) => (
                      <div key={cp.id} className="flex items-center justify-between bg-abyss/40 border border-edge/40 rounded-xl px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{cp.chapterTitle}</p>
                          <p className="text-xs text-ink-faint">{new Date(cp.createdAt).toLocaleString()}</p>
                        </div>
                        <button onClick={() => rewindTo(cp.id)} disabled={rewinding} className="ml-3 px-4 py-2 rounded-lg bg-arcane/15 border border-arcane/30 text-arcane text-sm font-medium hover:bg-arcane/25 disabled:opacity-50 transition">
                          {rewinding ? '…' : 'Rewind'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Inventory / Character Sheet Drawer */}
        <AnimatePresence>
          {showInventory && session && (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowInventory(false)} className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
              <motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 300 }} className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-panel border-l border-edge shadow-2xl flex flex-col" role="dialog" aria-label="Character sheet and inventory">
                <div className="flex items-center justify-between p-6 border-b border-edge/60">
                  <h2 className="font-prose text-xl">Character Sheet</h2>
                  <button onClick={() => setShowInventory(false)} className="text-ink-faint hover:text-ink transition text-xl" aria-label="Close">✕</button>
                </div>
                <div className="flex gap-2 p-4 border-b border-edge/40">
                  {(['stats', 'inventory', 'relationships'] as const).map((tab) => (
                    <button key={tab} onClick={() => setInventoryTab(tab)} className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition ${inventoryTab === tab ? 'bg-arcane/15 text-arcane border border-arcane/30' : 'text-ink-dim hover:text-ink border border-transparent'}`}>
                      {tab === 'stats' ? '📊 Stats' : tab === 'inventory' ? '🎒 Inventory' : '💭 Relations'}
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto p-6">
                  {(() => {
                    const vars = session.variables || {};
                    const entries = Object.entries(vars);
                    if (entries.length === 0) {
                      return <p className="text-ink-faint text-sm text-center py-8">No variables tracked yet.<br />Your choices will shape your story.</p>;
                    }
                    // Categorize: numbers → stats, booleans/strings → inventory, rel_* → relationships
                    const stats = entries.filter(([k, v]) => typeof v === 'number');
                    const inventory = entries.filter(([k, v]) => (typeof v === 'boolean' && v === true) || (typeof v === 'string' && !k.startsWith('rel_')));
                    const relationships = entries.filter(([k]) => k.startsWith('rel_') || k.startsWith('trust_') || k.startsWith('rep_'));

                    const display = inventoryTab === 'stats' ? stats : inventoryTab === 'inventory' ? inventory : relationships;

                    if (display.length === 0) {
                      const emptyMsg = inventoryTab === 'stats' ? 'No stats tracked yet.' : inventoryTab === 'inventory' ? 'No items acquired yet.' : 'No relationships tracked yet.';
                      return <p className="text-ink-faint text-sm text-center py-8">{emptyMsg}</p>;
                    }

                    return (
                      <div className="space-y-3">
                        {display.map(([key, value]) => (
                          <div key={key} className="flex items-center justify-between bg-abyss/40 border border-edge/40 rounded-xl px-4 py-3">
                            <span className="text-sm text-ink-dim capitalize">{key.replace(/_/g, ' ')}</span>
                            <span className="text-sm font-semibold text-ink">
                              {typeof value === 'boolean' ? (value ? '✓' : '—') : String(value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        {/* Toast notifications for consequence cues (Item F) */}
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none" aria-live="polite">
          <AnimatePresence>
            {toasts.map((toast) => (
              <motion.div key={toast.id} initial={{ opacity: 0, y: 20, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.95 }} className="bg-panel border border-arcane/30 rounded-xl px-5 py-3 shadow-2xl flex items-center gap-3 pointer-events-auto">
                <span className="text-arcane">✦</span>
                <span className="text-sm text-ink font-medium">{toast.text}</span>
                <button onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))} className="text-ink-faint hover:text-ink ml-2" aria-label="Dismiss">✕</button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    );
  }

  // Library view
  return (
    <div className="min-h-screen bg-void">
      <div className="absolute inset-0 pointer-events-none"><div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_0%,rgba(34,211,238,0.06),transparent)]" /></div>
      <header className="sticky top-0 z-10 bg-void/85 backdrop-blur-xl border-b border-edge/70">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-arcane to-voidlight flex items-center justify-center shadow-glow-cyan"><span className="text-void font-bold">R</span></div>
            <div><h1 className="text-[15px] font-bold tracking-tight leading-none">Re<span className="text-arcane">:</span>NeWrld</h1><p className="text-[11px] text-ink-faint mt-0.5">Reader</p></div>
          </div>
          <div className="flex items-center gap-3">
            <ViewToggle current="reader" />
            {becomeCreatorButton}
            <button onClick={logout} className="text-xs text-ink-faint hover:text-blood transition">Sign out</button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-10 relative">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="mb-8">
          <p className="text-[11px] uppercase tracking-[0.25em] text-arcane/80 font-medium mb-2">The Library</p>
          <h2 className="font-prose text-4xl tracking-tight mb-3">Choose your story</h2>
          <p className="text-ink-dim max-w-xl mb-6">Living narratives that remember every choice. Pick a world and shape its fate.</p>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <div className="relative flex-1 max-w-sm">
              <input
                value={searchInput}
                onChange={(e) => { setSearchInput(e.target.value); setSearchQuery(e.target.value); }}
                placeholder="Search worlds…"
                aria-label="Search published worlds"
                className="w-full bg-panel/60 border border-edge/70 rounded-xl px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint/60 focus:border-arcane/50 focus:outline-none transition"
              />
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by genre">
              <button
                onClick={() => setGenreFilter(null)}
                className={`text-xs px-3 py-1.5 rounded-full border transition ${genreFilter === null ? 'border-arcane bg-arcane/15 text-ink' : 'border-edge text-ink-dim hover:border-edge-2 hover:text-ink'}`}
              >
                All
              </button>
              {WORLD_GENRES.map((g) => (
                <button
                  key={g}
                  onClick={() => setGenreFilter(genreFilter === g ? null : g)}
                  className={`text-xs px-3 py-1.5 rounded-full border capitalize transition ${genreFilter === g ? 'border-arcane bg-arcane/15 text-ink' : 'border-edge text-ink-dim hover:border-edge-2 hover:text-ink'}`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        </motion.div>
        {loading && <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">{[1,2,3].map(i => <div key={i} className="bg-panel/40 border border-edge/50 rounded-2xl p-6 animate-pulse h-48" />)}</div>}
        {error && <div className="bg-blood/10 border border-blood/25 rounded-2xl p-6 text-blood text-sm">{error}</div>}
        {!loading && !error && (
          <>
            {catalog.length === 0 ? (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-20 border border-dashed border-edge rounded-2xl">
                <p className="text-4xl mb-4 opacity-60">📚</p>
                <p className="font-prose text-2xl mb-2">{genreFilter || searchQuery ? 'No worlds match your filters' : 'No published worlds yet'}</p>
                <p className="text-sm text-ink-dim max-w-sm mx-auto">
                  {genreFilter || searchQuery
                    ? 'Try a different genre or search term.'
                    : 'Stories are being crafted. Check back soon — or become a creator and write the first one.'}
                </p>
                {(genreFilter || searchQuery) && (
                  <button onClick={() => { setGenreFilter(null); setSearchInput(''); setSearchQuery(''); }} className="mt-4 text-sm text-arcane hover:underline">Clear filters</button>
                )}
              </motion.div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {catalog.map((w, i) => (
                  <motion.div key={w.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.07, 0.4), duration: 0.5 }} className="group bg-panel/60 border border-edge/70 rounded-2xl overflow-hidden hover:border-arcane/30 hover:shadow-panel transition-all cursor-pointer" onClick={() => startWorld(w.id)}>
                    <div className="h-32 bg-gradient-to-br from-arcane/20 via-voidlight/10 to-transparent relative overflow-hidden">
                      <div className="absolute inset-0 flex items-center justify-center text-5xl opacity-40">📖</div>
                      <div className="absolute inset-0 bg-gradient-to-t from-panel via-transparent to-transparent" />
                      {w.genre && <span className="absolute top-3 left-3 text-[10px] uppercase tracking-wider px-2 py-1 rounded-full bg-void/70 border border-edge/50 text-ink-dim capitalize">{w.genre}</span>}
                    </div>
                    <div className="p-6">
                      <h3 className="font-semibold text-lg tracking-tight mb-1 group-hover:text-arcane transition-colors">{w.title}</h3>
                      <p className="text-sm text-ink-dim line-clamp-2 mb-3">{w.description || 'A story waiting to be told.'}</p>
                      {w.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-4">
                          {w.tags.slice(0, 3).map((t) => (
                            <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-abyss text-ink-faint">#{t}</span>
                          ))}
                        </div>
                      )}
                      <span className="inline-flex items-center gap-2 text-sm text-arcane font-medium">Begin reading <span className="group-hover:translate-x-1 transition-transform">→</span></span>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
      <CreatorWelcomeToast show={showWelcomeToast} />
    </div>
  );
}

function CreatorWelcomeToast({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 400, damping: 28 }}
          className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-panel border border-arcane/40 rounded-2xl px-5 py-4 shadow-glow-cyan"
          role="status"
          aria-live="polite"
        >
          <span className="w-8 h-8 rounded-full bg-gradient-to-br from-arcane to-[#0ea5c4] flex items-center justify-center text-void font-bold">✦</span>
          <div>
            <p className="text-sm font-semibold text-ink">Welcome, Creator</p>
            <p className="text-xs text-ink-dim">Your studio is ready — entering now…</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
