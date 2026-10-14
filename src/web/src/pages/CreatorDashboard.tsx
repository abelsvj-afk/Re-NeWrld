import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { motion } from 'framer-motion';
import { worldsApi, ApiError, type WorldSummary } from '../lib/api';
import { useAuth } from '../stores/auth';

function StatusBadge({ status }: { status: WorldSummary['status'] }) {
  const styles = {
    draft: 'border-ember/30 bg-ember/10 text-ember',
    published: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    archived: 'border-edge-2 bg-panel text-ink-faint',
  } as const;
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${styles[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export function CreatorDashboard() {
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setWorlds(await worldsApi.list());
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load worlds');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = worlds.filter((w) =>
    w.title.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="min-h-screen bg-void flex">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-edge bg-abyss/60 flex flex-col">
        <div className="px-6 py-5 border-b border-edge">
          <h1 className="text-lg font-bold tracking-tight">
            Re<span className="text-arcane">:</span>NeWrld
          </h1>
          <p className="text-xs text-ink-faint mt-0.5">Creator Studio</p>
        </div>
        <nav className="p-3 space-y-1 flex-1">
          {[
            { label: 'Dashboard', active: true },
            { label: 'Worlds', active: false },
            { label: 'Characters', active: false },
            { label: 'Analytics', active: false },
            { label: 'Settings', active: false },
          ].map((item) => (
            <div
              key={item.label}
              className={`px-4 py-2.5 rounded-lg text-sm transition ${
                item.active
                  ? 'bg-arcane/10 text-arcane border border-arcane/20'
                  : 'text-ink-dim hover:bg-panel hover:text-ink cursor-pointer'
              }`}
            >
              {item.label}
            </div>
          ))}
        </nav>
        <div className="p-4 border-t border-edge">
          <p className="text-xs text-ink-faint truncate">{user?.email}</p>
          <button
            onClick={logout}
            className="text-xs text-ink-dim hover:text-blood transition mt-1"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <header className="sticky top-0 z-10 bg-void/80 backdrop-blur border-b border-edge">
          <div className="px-8 py-5 flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Active Worlds</h2>
              <p className="text-sm text-ink-dim mt-1">
                {worlds.length} world{worlds.length === 1 ? '' : 's'} in your library
              </p>
            </div>
            <div className="flex items-center gap-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search worlds…"
                className="bg-abyss border border-edge rounded-lg px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-arcane focus:outline-none w-64 transition"
              />
              <button className="bg-arcane text-void text-sm font-semibold rounded-lg px-5 py-2.5 hover:bg-arcane/90 transition shadow-glow-cyan">
                + New World
              </button>
            </div>
          </div>
        </header>

        <div className="p-8">
          {loading && <p className="text-ink-dim animate-pulse">Loading worlds…</p>}
          {error && <p className="text-blood">{error}</p>}
          {!loading && !error && (
            <div className="grid gap-4">
              {filtered.map((w, i) => (
                <motion.div
                  key={w.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="glass rounded-xl p-6 flex items-center gap-6 hover:border-edge-2 transition"
                >
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-voidlight/30 to-arcane/20 border border-edge flex items-center justify-center text-2xl shrink-0">
                    📖
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="text-lg font-semibold truncate">{w.title}</h3>
                      <StatusBadge status={w.status} />
                    </div>
                    <p className="text-sm text-ink-dim line-clamp-1">{w.description}</p>
                    <p className="text-xs text-ink-faint mt-1">
                      Updated {new Date(w.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => navigate({ to: '/creator/worlds/$worldId/scenes', params: { worldId: w.id } })}
                      className="text-sm px-4 py-2 rounded-lg border border-edge text-ink-dim hover:border-arcane/50 hover:text-arcane transition"
                    >
                      Edit Scenes
                    </button>
                    {w.status === 'draft' && (
                      <button
                        onClick={() => navigate({ to: '/creator/worlds/$worldId/publish', params: { worldId: w.id } })}
                        className="text-sm px-4 py-2 rounded-lg bg-ember/15 border border-ember/30 text-ember hover:bg-ember/25 transition"
                      >
                        Publish
                      </button>
                    )}
                  </div>
                </motion.div>
              ))}
              {filtered.length === 0 && (
                <div className="text-center py-16">
                  <p className="text-ink-faint mb-4">No worlds match your search.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
