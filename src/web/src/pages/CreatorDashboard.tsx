import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { worldsApi, ApiError, type WorldSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { TaxonomyInputs, parseTags } from '../components/TaxonomyInputs';
import { ViewToggle } from '../components/ViewToggle';

const NAV = [
  { label: 'Dashboard', icon: '◈', active: true, action: 'dashboard' as const },
  { label: 'Worlds', icon: '◉', active: false, action: 'worlds' as const },
];

function StatusBadge({ status }: { status: WorldSummary['status'] }) {
  const styles = {
    draft: 'border-ember/30 bg-ember/10 text-ember',
    published: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    archived: 'border-edge-2 bg-panel text-ink-faint',
  } as const;
  const dot = { draft: 'bg-ember', published: 'bg-emerald-400', archived: 'bg-ink-faint' } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot[status]}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

const GRADIENTS = [
  'from-violet-500/25 via-purple-500/10 to-transparent',
  'from-cyan-500/25 via-sky-500/10 to-transparent',
  'from-amber-500/25 via-orange-500/10 to-transparent',
  'from-rose-500/25 via-pink-500/10 to-transparent',
  'from-emerald-500/25 via-teal-500/10 to-transparent',
];

export function CreatorDashboard() {
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showNewWorld, setShowNewWorld] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newGenre, setNewGenre] = useState('');
  const [newTags, setNewTags] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingWorld, setEditingWorld] = useState<WorldSummary | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editGenre, setEditGenre] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editCoverUrl, setEditCoverUrl] = useState('');
  const [uploadingCover, setUploadingCover] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const startEdit = (w: WorldSummary) => {
    setEditingWorld(w);
    setEditTitle(w.title);
    setEditDesc(w.description ?? '');
    setEditGenre(w.metadata?.genre ?? '');
    setEditTags((w.metadata?.tags ?? []).join(', '));
    setEditCoverUrl((w.metadata as any)?.coverArtUrl ?? '');
  };

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editingWorld) return;
    setUploadingCover(true);
    try {
      const res = await worldsApi.uploadMedia(editingWorld.id, file);
      setEditCoverUrl(res.url);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploadingCover(false);
    }
  };

  const buildMetadata = (genre: string, tagsInput: string) => {
    const metadata: { genre?: string; tags?: string[] } = {};
    if (genre) metadata.genre = genre;
    const tags = parseTags(tagsInput);
    if (tags.length > 0) metadata.tags = tags;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  };

  // Edit variant: merges with the world's existing metadata so other keys
  // survive, and explicitly deletes genre/tags when the user clears them.
  const buildEditMetadata = (base: Record<string, unknown> | undefined, genre: string, tagsInput: string) => {
    const metadata: Record<string, unknown> = { ...(base ?? {}) };
    if (genre) metadata.genre = genre; else delete metadata.genre;
    const tags = parseTags(tagsInput);
    if (tags.length > 0) metadata.tags = tags; else delete metadata.tags;
    return metadata;
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingWorld || !editTitle.trim() || savingEdit) return;
    setSavingEdit(true);
    try {
      const metadata = buildEditMetadata(
        editingWorld.metadata as Record<string, unknown> | undefined,
        editGenre,
        editTags
      ) as Record<string, unknown>;
      if (editCoverUrl) metadata.coverArtUrl = editCoverUrl;
      await worldsApi.update(editingWorld.id, { title: editTitle.trim(), description: editDesc.trim() || undefined, metadata: metadata as { genre?: string; tags?: string[]; coverArtUrl?: string } });
      setWorlds((prev) => prev.map((w) => w.id === editingWorld.id ? { ...w, title: editTitle.trim(), description: editDesc.trim(), metadata } : w));
      setEditingWorld(null);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update world'); }
    finally { setSavingEdit(false); }
  };

  const deleteWorld = async (w: WorldSummary) => {
    if (!confirm(`Delete "${w.title}"? This cannot be undone.`)) return;
    setDeletingId(w.id);
    try {
      await worldsApi.remove(w.id);
      setWorlds((prev) => prev.filter((x) => x.id !== w.id));
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to delete world'); }
    finally { setDeletingId(null); }
  };

  useEffect(() => {
    (async () => {
      try { setWorlds(await worldsApi.list()); }
      catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to load worlds'); }
      finally { setLoading(false); }
    })();
  }, []);

  const createWorld = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const metadata = buildMetadata(newGenre, newTags);
      const w = await worldsApi.create({ title: newTitle.trim(), description: newDesc.trim() || undefined, metadata });
      setShowNewWorld(false);
      setNewTitle(''); setNewDesc(''); setNewGenre(''); setNewTags('');
      navigate({ to: '/creator/worlds/$worldId/scenes', params: { worldId: w.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create world');
    } finally {
      setCreating(false);
    }
  };

  const filtered = worlds.filter((w) => w.title.toLowerCase().includes(query.toLowerCase()));
  const stats = [
    { label: 'Total Worlds', value: worlds.length, icon: '◉', accent: 'text-arcane' },
    { label: 'Published', value: worlds.filter(w => w.status === 'published').length, icon: '⬢', accent: 'text-emerald-400' },
    { label: 'In Draft', value: worlds.filter(w => w.status === 'draft').length, icon: '⬣', accent: 'text-ember' },
  ];

  return (
    <div className="min-h-screen bg-void flex">
      <aside className="w-[240px] shrink-0 border-r border-edge/70 bg-abyss/50 hidden md:flex flex-col">
        <div className="px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-arcane to-voidlight flex items-center justify-center shadow-glow-cyan shrink-0">
              <span className="text-void font-bold">R</span>
            </div>
            <div>
              <h1 className="text-[15px] font-bold tracking-tight leading-none">Re<span className="text-arcane">:</span>NeWrld</h1>
              <p className="text-[11px] text-ink-faint mt-1">Creator Studio</p>
            </div>
          </div>
        </div>
        <nav className="px-3 space-y-1 flex-1">
          <p className="px-3 mb-2 text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">Workspace</p>
          {NAV.map((item) => (
            <button key={item.label} onClick={() => {
              if (item.action === 'worlds') document.getElementById('worlds-section')?.scrollIntoView({ behavior: 'smooth' });
              else window.scrollTo({ top: 0, behavior: 'smooth' });
            }} className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition flex items-center gap-3 ${item.active ? 'bg-arcane/[0.08] text-arcane border border-arcane/20 font-medium' : 'text-ink-dim hover:bg-panel hover:text-ink cursor-pointer border border-transparent'}`}>
              <span className="text-base w-5 text-center opacity-80">{item.icon}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-edge/70">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-arcane/40 to-voidlight/40 border border-edge flex items-center justify-center text-xs font-semibold shrink-0">{user?.email?.[0]?.toUpperCase() ?? '?'}</div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium truncate">{user?.email}</p>
              <button onClick={logout} className="text-[11px] text-ink-faint hover:text-blood transition">Sign out</button>
            </div>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto min-w-0">
        <header className="sticky top-0 z-10 bg-void/85 backdrop-blur-xl border-b border-edge/70">
          <div className="px-6 lg:px-10 py-5 flex items-center justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.25em] text-arcane/80 font-medium mb-1">Arcane Atlas</p>
              <h2 className="font-prose text-2xl lg:text-3xl tracking-tight">Active Worlds</h2>
            </div>
            <div className="flex items-center gap-3">
              <ViewToggle current="creator" />
              <div className="relative hidden sm:block">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search worlds…" className="bg-panel border border-edge rounded-xl pl-10 pr-4 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 w-60 transition-all" />
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint text-sm">⌕</span>
              </div>
              <button onClick={() => setShowNewWorld(true)} className="bg-gradient-to-r from-arcane to-[#0ea5c4] text-void text-sm font-semibold rounded-xl px-5 py-2.5 hover:brightness-110 transition-all shadow-glow-cyan whitespace-nowrap">+ New World</button>
            </div>
          </div>
        </header>
        <div className="p-6 lg:p-10 max-w-6xl">
          <div className="grid grid-cols-3 gap-4 mb-8">
            {stats.map((s, i) => (
              <motion.div key={s.label} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07, duration: 0.5 }} className="bg-panel/60 border border-edge/70 rounded-2xl p-5">
                <span className={`text-xl ${s.accent}`}>{s.icon}</span>
                <p className="text-3xl font-semibold tracking-tight mt-2 mb-1">{s.value}</p>
                <p className="text-xs text-ink-faint uppercase tracking-widest">{s.label}</p>
              </motion.div>
            ))}
          </div>
          <div id="worlds-section" className="flex items-center justify-between mb-4 scroll-mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-ink-dim">Your Worlds</h3>
            <span className="text-xs text-ink-faint">{loading ? 'Loading…' : `${filtered.length} shown`}</span>
          </div>
          {loading && <div className="space-y-4">{[1,2,3].map(i => <div key={i} className="bg-panel/40 border border-edge/50 rounded-2xl p-6 animate-pulse"><div className="h-5 bg-edge/50 rounded w-1/3 mb-3" /><div className="h-3 bg-edge/30 rounded w-1/2" /></div>)}</div>}
          {error && <div className="bg-blood/10 border border-blood/25 rounded-2xl p-6 text-blood text-sm">{error}</div>}
          {!loading && !error && (
            <div className="grid gap-4">
              {filtered.map((w, i) => (
                <motion.div key={w.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.06, 0.4), duration: 0.5 }} className="group relative bg-panel/60 border border-edge/70 rounded-2xl overflow-hidden hover:border-edge-2 transition-all hover:shadow-panel">
                  <div className={`absolute inset-0 bg-gradient-to-r ${GRADIENTS[i % GRADIENTS.length]} opacity-60 pointer-events-none`} />
                  <div className="relative p-6 flex items-center gap-6">
                    <div className="w-16 h-16 rounded-2xl bg-abyss border border-edge flex items-center justify-center text-3xl shrink-0 shadow-panel">📖</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-1.5 flex-wrap"><h3 className="text-lg font-semibold tracking-tight truncate">{w.title}</h3><StatusBadge status={w.status} /></div>
                      <p className="text-sm text-ink-dim line-clamp-1 mb-1">{w.description || 'No description yet.'}</p>
                      <p className="text-xs text-ink-faint">Updated {new Date(w.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => navigate({ to: '/creator/worlds/$worldId/scenes', params: { worldId: w.id } })} className="text-sm font-medium px-4 py-2.5 rounded-xl border border-edge bg-abyss/50 text-ink-dim hover:border-arcane/50 hover:text-arcane transition-all">Edit Scenes</button>
                      {w.status === 'draft' && <button onClick={() => navigate({ to: '/creator/worlds/$worldId/publish', params: { worldId: w.id } })} className="text-sm font-medium px-4 py-2.5 rounded-xl bg-ember/10 border border-ember/30 text-ember hover:bg-ember/20 transition-all">Publish</button>}
                      <button onClick={() => startEdit(w)} className="text-sm font-medium px-3 py-2.5 rounded-xl border border-edge bg-abyss/50 text-ink-faint hover:border-edge-2 hover:text-ink transition-all" title="Edit world details">✎</button>
                      <button onClick={() => deleteWorld(w)} disabled={deletingId === w.id} className="text-sm font-medium px-3 py-2.5 rounded-xl border border-edge bg-abyss/50 text-ink-faint hover:border-blood/50 hover:text-blood transition-all disabled:opacity-50" title="Delete world">🗑</button>
                    </div>
                  </div>
                </motion.div>
              ))}
              {filtered.length === 0 && (
                <div className="text-center py-20 border border-dashed border-edge rounded-2xl">
                  <p className="text-4xl mb-4">✦</p>
                  <p className="font-prose text-xl mb-2">No worlds yet</p>
                  <p className="text-sm text-ink-dim mb-6">Every universe starts with a single scene.</p>
                  <button onClick={() => setShowNewWorld(true)} className="bg-gradient-to-r from-arcane to-[#0ea5c4] text-void text-sm font-semibold rounded-xl px-6 py-3 hover:brightness-110 transition-all shadow-glow-cyan">Create your first world</button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {showNewWorld && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setShowNewWorld(false)}>
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-panel border border-edge rounded-2xl p-8 shadow-panel">
            <h3 className="font-prose text-2xl mb-1">New World</h3>
            <p className="text-sm text-ink-dim mb-6">Give your universe a name.</p>
            <form onSubmit={createWorld} className="space-y-4">
              <div>
                <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Title</label>
                <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required placeholder="The Shattered Crown" className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all" />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Description <span className="normal-case tracking-normal opacity-60">(optional)</span></label>
                <textarea value={newDesc} onChange={(e) => setNewDesc(e.target.value)} rows={3} placeholder="A tale of broken kingdoms…" className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all resize-none" />
              </div>
              <TaxonomyInputs genre={newGenre} setGenre={setNewGenre} tagsInput={newTags} setTagsInput={setNewTags} />
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowNewWorld(false)} className="flex-1 px-4 py-3 rounded-xl border border-edge text-ink-dim hover:border-edge-2 hover:text-ink transition-all text-sm font-medium">Cancel</button>
                <button type="submit" disabled={creating || !newTitle.trim()} className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-arcane to-[#0ea5c4] text-void font-semibold hover:brightness-110 disabled:opacity-50 transition-all text-sm shadow-glow-cyan">{creating ? 'Creating…' : 'Create World'}</button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {editingWorld && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setEditingWorld(null)}>
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-panel border border-edge rounded-2xl p-8 shadow-panel">
            <h3 className="font-prose text-2xl mb-1">Edit World</h3>
            <p className="text-sm text-ink-dim mb-6">Update your world's details.</p>
            <form onSubmit={saveEdit} className="space-y-4">
              <div>
                <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Title</label>
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all" />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Description <span className="normal-case tracking-normal opacity-60">(optional)</span></label>
                <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={3} className="w-full bg-abyss border border-edge rounded-xl px-4 py-3 text-ink placeholder:text-ink-faint/60 focus:border-arcane focus:outline-none focus:ring-2 focus:ring-arcane/20 transition-all resize-none" />
              </div>
              <TaxonomyInputs genre={editGenre} setGenre={setEditGenre} tagsInput={editTags} setTagsInput={setEditTags} />
              <div>
                <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-faint mb-2 font-medium">Cover Art</label>
                <div className="flex items-start gap-4">
                  {editCoverUrl ? (
                    <img src={editCoverUrl} alt="Cover" className="w-20 h-28 object-cover rounded-lg border border-edge" />
                  ) : (
                    <div className="w-20 h-28 rounded-lg border border-dashed border-edge flex items-center justify-center text-ink-faint text-xs text-center px-2">No cover</div>
                  )}
                  <div className="flex-1">
                    <label className="inline-block px-4 py-2.5 rounded-xl border border-edge text-ink-dim hover:border-arcane hover:text-ink transition-all text-sm font-medium cursor-pointer">
                      {uploadingCover ? 'Uploading…' : 'Upload Cover'}
                      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleCoverUpload} disabled={uploadingCover} className="hidden" />
                    </label>
                    <p className="text-[11px] text-ink-faint mt-2">JPEG, PNG, WebP or GIF. Max 10MB.</p>
                  </div>
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setEditingWorld(null)} className="flex-1 px-4 py-3 rounded-xl border border-edge text-ink-dim hover:border-edge-2 hover:text-ink transition-all text-sm font-medium">Cancel</button>
                <button type="submit" disabled={savingEdit || !editTitle.trim()} className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-arcane to-[#0ea5c4] text-void font-semibold hover:brightness-110 disabled:opacity-50 transition-all text-sm shadow-glow-cyan">{savingEdit ? 'Saving…' : 'Save Changes'}</button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}
