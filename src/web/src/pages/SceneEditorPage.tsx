import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { motion, AnimatePresence } from 'framer-motion';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { worldsApi, ApiError, type SceneSummary, type ChoiceSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { NarrationPanel } from '../components/NarrationPanel';

const TABS = ['Scene', 'Script', 'Flow', 'Assets'] as const;

export function SceneEditorPage() {
  const { worldId } = useParams({ strict: false }) as { worldId: string };
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [narrationStatus, setNarrationStatus] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<ChoiceSummary[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<typeof TABS[number]>('Scene');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [showNewScene, setShowNewScene] = useState(false);
  const [newSceneTitle, setNewSceneTitle] = useState('');
  const [newSceneIsEnding, setNewSceneIsEnding] = useState(false);
  const [creatingScene, setCreatingScene] = useState(false);
  const [showNewChoice, setShowNewChoice] = useState(false);
  const [newChoiceText, setNewChoiceText] = useState('');
  const [newChoiceTarget, setNewChoiceTarget] = useState('');
  const [creatingChoice, setCreatingChoice] = useState(false);
  const [worldTitle, setWorldTitle] = useState('');

  const activeScene = scenes.find((s) => s.id === activeSceneId) ?? null;
  const sceneChoices = choices.filter((c) => c.sceneId === activeSceneId);

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    editorProps: { attributes: { class: 'scene-prose focus:outline-none min-h-[280px]' } },
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c, w] = await Promise.all([worldsApi.scenes(worldId), worldsApi.choices(worldId), worldsApi.get(worldId)]);
      setScenes(s); setChoices(c); setWorldTitle(w.title ?? '');
      worldsApi.narrationStatus(worldId).then(setNarrationStatus).catch(() => {});
      if (s.length > 0 && !activeSceneId) setActiveSceneId(s[0].id);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [worldId]);

  useEffect(() => { load(); }, [worldId]);
  useEffect(() => {
    if (activeScene && editor) { setTitle(activeScene.title); editor.commands.setContent(activeScene.prose); }
  }, [activeSceneId]);

  const save = async () => {
    if (!activeScene || !editor || saving) return;
    setSaving(true); setError(null);
    try {
      await worldsApi.updateScene(worldId, activeScene.id, { title, prose: editor.getHTML() });
      setScenes((prev) => prev.map((s) => (s.id === activeScene.id ? { ...s, title } : s)));
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const [deletingSceneId, setDeletingSceneId] = useState<string | null>(null);
  const [deletingChoiceId, setDeletingChoiceId] = useState<string | null>(null);

  const deleteScene = async (sceneId: string) => {
    if (!window.confirm('Delete this scene? Its choices will be orphaned. This cannot be undone.')) return;
    setDeletingSceneId(sceneId);
    setError(null);
    try {
      await worldsApi.deleteScene(worldId, sceneId);
      setScenes((prev) => prev.filter((s) => s.id !== sceneId));
      setChoices((prev) => prev.filter((c) => c.sceneId !== sceneId && c.targetSceneId !== sceneId));
      if (activeSceneId === sceneId) {
        const remaining = scenes.filter((s) => s.id !== sceneId);
        setActiveSceneId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete scene');
    } finally {
      setDeletingSceneId(null);
    }
  };

  const deleteChoice = async (choiceId: string) => {
    if (!window.confirm('Delete this choice? This cannot be undone.')) return;
    setDeletingChoiceId(choiceId);
    setError(null);
    try {
      await worldsApi.deleteChoice(worldId, choiceId);
      setChoices((prev) => prev.filter((c) => c.id !== choiceId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete choice');
    } finally {
      setDeletingChoiceId(null);
    }
  };

  const toggleEnding = async (scene: SceneSummary) => {
    setError(null);
    const next = !scene.isEnding;
    // Optimistic update
    setScenes((prev) => prev.map((s) => (s.id === scene.id ? { ...s, isEnding: next } : s)));
    try {
      await worldsApi.updateScene(worldId, scene.id, { isEnding: next });
    } catch (err) {
      // Roll back on failure
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? { ...s, isEnding: !next } : s)));
      setError(err instanceof ApiError ? err.message : 'Failed to update ending flag');
    }
  };

  const createScene = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSceneTitle.trim() || creatingScene) return;
    setCreatingScene(true); setError(null);
    try {
      const res = await worldsApi.createScene(worldId, {
        title: newSceneTitle.trim(),
        prose: '<p>Begin writing…</p>',
        isEnding: newSceneIsEnding,
      });
      const newScene: SceneSummary = { id: res.sceneId, title: newSceneTitle.trim(), isEnding: newSceneIsEnding } as SceneSummary;
      setScenes((prev) => [...prev, newScene]);
      setActiveSceneId(res.sceneId);
      setShowNewScene(false);
      setNewSceneTitle('');
      setNewSceneIsEnding(false);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to create scene'); }
    finally { setCreatingScene(false); }
  };

  const createChoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChoiceText.trim() || !newChoiceTarget || !activeSceneId || creatingChoice) return;
    setCreatingChoice(true); setError(null);
    try {
      const res = await worldsApi.createChoice(worldId, {
        sceneId: activeSceneId,
        targetSceneId: newChoiceTarget,
        text: newChoiceText.trim(),
      });
      setChoices((prev) => [...prev, { id: res.choiceId, sceneId: activeSceneId, targetSceneId: newChoiceTarget, text: newChoiceText.trim() } as ChoiceSummary]);
      setShowNewChoice(false);
      setNewChoiceText(''); setNewChoiceTarget('');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to create choice'); }
    finally { setCreatingChoice(false); }
  };

  if (loading) return <div className="min-h-screen bg-void flex items-center justify-center"><div className="text-ink-dim animate-pulse font-prose text-lg">Opening narrative arc…</div></div>;

  const sceneNumber = activeScene ? scenes.findIndex(s => s.id === activeScene.id) + 1 : 0;

  return (
    <div className="min-h-screen bg-void flex flex-col">
      <style>{`.scene-prose{font-family:Georgia,serif;font-size:1.05rem;line-height:1.9;color:#f2f0ea}.scene-prose p{margin-bottom:1em}.scene-prose:focus{outline:none}`}</style>

      {/* Top bar */}
      <header className="border-b border-edge/70 bg-abyss/60 backdrop-blur-xl">
        <div className="flex items-center justify-between px-5 py-3">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate({ to: '/creator' })} className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-arcane to-voidlight flex items-center justify-center"><span className="text-void font-bold text-sm">N</span></div>
              <div className="text-left"><p className="text-[13px] font-bold tracking-[0.18em]">NARRATIVE ARC</p><p className="text-[10px] text-ink-faint">Project: {worldTitle || 'Untitled'}</p></div>
            </button>
            <nav className="hidden md:flex items-center gap-1 ml-6 bg-panel/50 border border-edge/60 rounded-xl p-1">
              {TABS.map(t => (
                <button key={t} onClick={() => setActiveTab(t)} className={`px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all ${activeTab === t ? 'bg-arcane/15 text-arcane border border-arcane/25' : 'text-ink-dim hover:text-ink border border-transparent'}`}>{t}</button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-faint mr-2 hidden sm:block">{saving ? 'Saving…' : 'Saved'}</span>
            <button onClick={save} disabled={saving} className="text-[13px] font-medium px-4 py-2 rounded-xl border border-edge bg-panel text-ink-dim hover:border-arcane/40 hover:text-arcane transition-all disabled:opacity-50">Save</button>
            <button onClick={() => navigate({ to: '/creator/worlds/$worldId/publish', params: { worldId } })} className="text-[13px] font-semibold px-4 py-2 rounded-xl bg-gradient-to-r from-arcane to-[#0ea5c4] text-void hover:brightness-110 transition-all shadow-glow-cyan">Publish</button>
            <button onClick={logout} className="text-xs text-ink-faint hover:text-blood transition ml-2">Sign out</button>
          </div>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Project panel */}
        <aside className="w-[260px] shrink-0 border-r border-edge/70 bg-abyss/40 hidden lg:flex flex-col">
          <div className="px-5 py-4 border-b border-edge/60 flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-[0.25em] text-ink-faint font-semibold">Project Panel</p>
            <button onClick={() => setShowNewScene(true)} className="text-arcane hover:text-arcane/80 text-lg leading-none font-bold" title="Add scene">+</button>
          </div>
          <div className="flex-1 overflow-auto p-3">
            <p className="px-3 py-2 text-[11px] font-semibold text-ember/90 uppercase tracking-widest">Act 1: The Beginning</p>
            <div className="space-y-0.5">
              {scenes.map((s, i) => (
                <button key={s.id} onClick={() => setActiveSceneId(s.id)} className={`w-full text-left px-3 py-2.5 rounded-lg transition-all group ${s.id === activeSceneId ? 'bg-arcane/[0.08] border border-arcane/25' : 'border border-transparent hover:bg-panel'}`}>
                  <div className="flex items-center gap-3">
                    <span className={`text-[11px] font-mono w-7 ${s.id === activeSceneId ? 'text-arcane' : 'text-ink-faint'}`}>{String(i + 1).padStart(2, '0')}</span>
                    <div className="min-w-0 flex-1"><p className={`text-[13px] truncate ${s.id === activeSceneId ? 'text-ink font-medium' : 'text-ink-dim group-hover:text-ink'}`}>{s.title}</p><div className="flex items-center gap-2">{s.isEnding && <span className="text-[10px] text-ember">◆ Ending</span>}{narrationStatus[s.id] && <span className="text-[10px] text-arcane" title="Narration generated">🎧</span>}</div></div>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Delete scene ${s.title}`}
                      onClick={(e) => { e.stopPropagation(); deleteScene(s.id); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); deleteScene(s.id); } }}
                      className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-blood text-sm px-1 transition-all"
                    >
                      {deletingSceneId === s.id ? '…' : '🗑'}
                    </span>
                  </div>
                </button>
              ))}
              {scenes.length === 0 && <div className="text-ink-faint text-[13px] px-3 py-8 text-center"><p className="mb-3">No scenes yet.<br/>Create your first scene to begin.</p><button onClick={() => setShowNewScene(true)} className="text-arcane text-[13px] font-medium hover:underline">+ Add scene</button></div>}
            </div>
          </div>
        </aside>

        {/* Main scene content */}
        <main className="flex-1 overflow-auto min-w-0 bg-[radial-gradient(ellipse_60%_40%_at_50%_0%,rgba(34,211,238,0.04),transparent)]">
          <div className="max-w-3xl mx-auto px-8 py-10">
            {error && <div className="bg-blood/10 border border-blood/25 rounded-xl p-4 text-blood text-sm mb-6">{error}</div>}
            {activeScene ? (
              <AnimatePresence mode="wait">
                <motion.div key={activeScene.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4 }}>
                  <div className="mb-8">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[11px] uppercase tracking-[0.3em] text-arcane/80 font-semibold">Scene {sceneNumber}</p>
                      <label className="flex items-center gap-2 cursor-pointer select-none text-xs">
                        <input type="checkbox" checked={!!activeScene.isEnding} onChange={() => toggleEnding(activeScene)} className="w-3.5 h-3.5 rounded accent-amber-500" />
                        <span className={activeScene.isEnding ? 'text-ember font-medium' : 'text-ink-faint'}>◆ Ending</span>
                      </label>
                    </div>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Scene title" className="bg-transparent font-prose text-3xl md:text-4xl tracking-tight focus:outline-none w-full placeholder:text-ink-faint/50 border-b border-transparent focus:border-arcane/30 pb-2 transition-colors" />
                  </div>
                  <div className="bg-panel/40 border border-edge/60 rounded-2xl p-8 mb-8"><EditorContent editor={editor} /></div>

                  <NarrationPanel worldId={worldId} sceneId={activeScene.id} onGenerated={() => setNarrationStatus((prev) => ({ ...prev, [activeScene.id]: true }))} />

                  {/* Branching choices */}
                  <div className="mb-8">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-[11px] uppercase tracking-[0.25em] text-ink-faint font-semibold">Branching Choices</h3>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-ink-faint">{sceneChoices.length} choice{sceneChoices.length === 1 ? '' : 's'}</span>
                        {activeScene && scenes.length > 1 && (
                          <button onClick={() => { setNewChoiceTarget(''); setShowNewChoice(true); }} className="text-xs font-medium text-ember hover:text-ember/80 transition">+ Add choice</button>
                        )}
                      </div>
                    </div>
                    <div className="space-y-3">
                      {sceneChoices.map((c, i) => (
                        <motion.div key={c.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="group relative bg-gradient-to-r from-ember/[0.06] to-transparent border border-edge/70 rounded-xl p-5 hover:border-ember/30 transition-all">
                          <div className="flex items-start gap-4">
                            <span className="w-8 h-8 rounded-lg bg-ember/10 border border-ember/25 text-ember text-sm font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                            <div className="flex-1 min-w-0"><p className="text-[15px] leading-relaxed mb-1">{c.text}</p><p className="text-xs text-ink-faint">→ {scenes.find((s) => s.id === c.targetSceneId)?.title ?? 'Unlinked'}</p></div>
                            <button
                              onClick={() => deleteChoice(c.id)}
                              aria-label="Delete choice"
                              disabled={deletingChoiceId === c.id}
                              className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-blood text-sm px-1 transition-all shrink-0"
                            >
                              {deletingChoiceId === c.id ? '…' : '🗑'}
                            </button>
                          </div>
                        </motion.div>
                      ))}
                      {sceneChoices.length === 0 && <div className="border border-dashed border-edge rounded-xl p-8 text-center"><p className="text-sm text-ink-faint">No branching choices yet.<br/>Add choices to let readers shape the story.</p></div>}
                    </div>
                  </div>
                </motion.div>
              </AnimatePresence>
            ) : (
              <div className="text-center py-24"><p className="font-prose text-2xl mb-3 text-ink-dim">Select a scene</p><p className="text-sm text-ink-faint">Choose from the project panel to begin editing.</p></div>
            )}
          </div>
        </main>

        {/* Scene conditions */}
        <aside className="w-[280px] shrink-0 border-l border-edge/70 bg-abyss/40 hidden xl:flex flex-col">
          <div className="px-5 py-4 border-b border-edge/60"><p className="text-[10px] uppercase tracking-[0.25em] text-ink-faint font-semibold">Scene Conditions</p></div>
          <div className="flex-1 overflow-auto p-5 space-y-6">
            <div><p className="text-xs text-ink-faint mb-1">Node</p><p className="font-mono text-sm text-arcane">1.{sceneNumber}</p></div>
            <div><p className="text-[11px] uppercase tracking-widest text-ink-faint font-semibold mb-3">Inventory</p><div className="bg-panel/60 border border-edge/60 rounded-xl p-4"><p className="text-[13px] text-ink-dim">No requirements</p></div></div>
            <div><p className="text-[11px] uppercase tracking-widest text-ink-faint font-semibold mb-3">Relationships</p><div className="bg-panel/60 border border-edge/60 rounded-xl p-4"><p className="text-[13px] text-ink-dim">No conditions</p></div></div>
            <div><p className="text-[11px] uppercase tracking-widest text-ink-faint font-semibold mb-3">Objective</p><div className="bg-panel/60 border border-edge/60 rounded-xl p-4"><p className="text-[13px] text-ink-dim">Advance the narrative</p></div></div>
            <div><p className="text-[11px] uppercase tracking-widest text-ink-faint font-semibold mb-3">Flow</p><div className="bg-panel/60 border border-edge/60 rounded-xl p-4 h-32 flex items-center justify-center"><div className="flex items-center gap-2">{scenes.slice(0, 5).map((s, i) => (<div key={s.id} className="flex items-center">{i > 0 && <div className="w-4 h-px bg-edge-2" />}<div className={`w-3 h-3 rounded-full border ${s.id === activeSceneId ? 'bg-arcane border-arcane shadow-glow-cyan' : 'bg-panel border-edge-2'}`} /></div>))}</div></div></div>
          </div>
        </aside>
      </div>

      {/* Status bar */}
      <footer className="border-t border-edge/70 bg-abyss/60 px-5 py-2 flex items-center justify-between text-[11px] text-ink-faint">
        <div className="flex items-center gap-4"><span>{scenes.length} scenes</span><span>{choices.length} choices</span></div>
        <div className="flex items-center gap-2"><span className={`w-1.5 h-1.5 rounded-full ${saving ? 'bg-ember animate-pulse' : 'bg-emerald-400'}`} />{saving ? 'Saving…' : 'All changes saved'}</div>
      </footer>

      {showNewScene && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setShowNewScene(false)}>
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-panel border border-edge rounded-2xl p-8 shadow-panel">
            <h3 className="font-prose text-2xl mb-1">New Scene</h3>
            <p className="text-sm text-ink-dim mb-6">Add a scene to your narrative.</p>
            <form onSubmit={createScene} className="space-y-4">
              <div>
                <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Title</label>
                <input value={newSceneTitle} onChange={(e) => setNewSceneTitle(e.target.value)} required placeholder="The Whispering Reef" autoFocus className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all" />
              </div>
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input type="checkbox" checked={newSceneIsEnding} onChange={(e) => setNewSceneIsEnding(e.target.checked)} className="w-4 h-4 rounded accent-amber-500" />
                <span className="text-sm text-ink-dim">This scene is an <span className="text-ember font-medium">ending</span> <span className="text-ink-faint">(publishing requires at least one)</span></span>
              </label>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowNewScene(false)} className="flex-1 px-4 py-3 rounded-xl border border-edge text-ink-dim hover:border-edge-2 hover:text-ink transition-all text-sm font-medium">Cancel</button>
                <button type="submit" disabled={creatingScene || !newSceneTitle.trim()} className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-arcane to-[#0ea5c4] text-void font-semibold hover:brightness-110 disabled:opacity-50 transition-all text-sm shadow-glow-cyan">{creatingScene ? 'Creating…' : 'Create Scene'}</button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {showNewChoice && activeScene && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setShowNewChoice(false)}>
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-panel border border-edge rounded-2xl p-8 shadow-panel">
            <h3 className="font-prose text-2xl mb-1">New Choice</h3>
            <p className="text-sm text-ink-dim mb-6">From <span className="text-ink font-medium">{activeScene.title}</span></p>
            <form onSubmit={createChoice} className="space-y-4">
              <div>
                <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Choice text</label>
                <input value={newChoiceText} onChange={(e) => setNewChoiceText(e.target.value)} required placeholder="Enter the dark corridor…" autoFocus className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink placeholder:text-ink-faint/60 focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/20 transition-all" />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Leads to</label>
                <select value={newChoiceTarget} onChange={(e) => setNewChoiceTarget(e.target.value)} required className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/20 transition-all">
                  <option value="">Select a scene…</option>
                  {scenes.filter((s) => s.id !== activeSceneId).map((s) => (
                    <option key={s.id} value={s.id}>{s.title}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowNewChoice(false)} className="flex-1 px-4 py-3 rounded-xl border border-edge text-ink-dim hover:border-edge-2 hover:text-ink transition-all text-sm font-medium">Cancel</button>
                <button type="submit" disabled={creatingChoice || !newChoiceText.trim() || !newChoiceTarget} className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-ember to-[#d97706] text-void font-semibold hover:brightness-110 disabled:opacity-50 transition-all text-sm shadow-glow-amber">{creatingChoice ? 'Creating…' : 'Create Choice'}</button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}
