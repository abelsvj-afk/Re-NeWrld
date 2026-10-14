import { useEffect, useState, useCallback } from 'react';
import { useParams } from '@tanstack/react-router';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { worldsApi, ApiError, type SceneSummary, type ChoiceSummary } from '../lib/api';

export function SceneEditorPage() {
  const { worldId } = useParams({ strict: false }) as { worldId: string };
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [choices, setChoices] = useState<ChoiceSummary[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  const activeScene = scenes.find((s) => s.id === activeSceneId) ?? null;
  const sceneChoices = choices.filter((c) => c.sceneId === activeSceneId);

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    editorProps: {
      attributes: {
        class: 'prose-reading focus:outline-none min-h-[300px]',
      },
    },
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([
        worldsApi.scenes(worldId),
        worldsApi.choices(worldId),
      ]);
      setScenes(s);
      setChoices(c);
      if (s.length > 0 && !activeSceneId) setActiveSceneId(s[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [worldId, activeSceneId]);

  useEffect(() => {
    load();
  }, [worldId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeScene && editor) {
      setTitle(activeScene.title);
      editor.commands.setContent(activeScene.prose);
    }
  }, [activeSceneId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!activeScene || !editor || saving) return;
    setSaving(true);
    setError(null);
    try {
      await worldsApi.updateScene(worldId, activeScene.id, {
        title,
        prose: editor.getHTML(),
      });
      setScenes((prev) =>
        prev.map((s) => (s.id === activeScene.id ? { ...s, title } : s)),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center">
        <div className="text-ink-dim animate-pulse">Loading editor…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-void flex">
      {/* Scene list */}
      <aside className="w-72 shrink-0 border-r border-edge bg-abyss/60 flex flex-col">
        <div className="px-5 py-4 border-b border-edge">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-faint">
            Scenes
          </h2>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-1">
          {scenes.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSceneId(s.id)}
              className={`w-full text-left px-4 py-3 rounded-lg text-sm transition ${
                s.id === activeSceneId
                  ? 'bg-arcane/10 border border-arcane/30 text-ink'
                  : 'text-ink-dim hover:bg-panel hover:text-ink border border-transparent'
              }`}
            >
              <div className="font-medium truncate">{s.title}</div>
              {s.isEnding && (
                <span className="text-xs text-ember">◆ Ending</span>
              )}
            </button>
          ))}
          {scenes.length === 0 && (
            <p className="text-ink-faint text-sm px-4 py-6 text-center">
              No scenes yet.
            </p>
          )}
        </div>
      </aside>

      {/* Editor */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="border-b border-edge bg-abyss/40 px-8 py-4 flex items-center justify-between sticky top-0">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Scene title"
            className="bg-transparent text-xl font-semibold focus:outline-none focus:border-b focus:border-arcane/50 pb-1 w-full max-w-xl placeholder:text-ink-faint"
          />
          <button
            onClick={save}
            disabled={saving || !activeScene}
            className="ml-4 shrink-0 bg-arcane text-void text-sm font-semibold rounded-lg px-6 py-2.5 hover:bg-arcane/90 disabled:opacity-50 transition shadow-glow-cyan"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto px-8 py-10">
            {error && (
              <p className="text-blood text-sm bg-blood/10 border border-blood/20 rounded-lg px-4 py-3 mb-6">
                {error}
              </p>
            )}
            {activeScene ? (
              <>
                <EditorContent editor={editor} />
                <div className="mt-12 border-t border-edge pt-8">
                  <h3 className="text-sm font-semibold uppercase tracking-widest text-ink-faint mb-4">
                    Choices ({sceneChoices.length})
                  </h3>
                  <div className="space-y-2">
                    {sceneChoices.map((c) => (
                      <div
                        key={c.id}
                        className="glass rounded-lg px-5 py-3.5 flex items-center justify-between"
                      >
                        <span className="text-sm">{c.text}</span>
                        <span className="text-xs text-ink-faint font-mono">
                          → {scenes.find((s) => s.id === c.targetSceneId)?.title ?? '…'}
                        </span>
                      </div>
                    ))}
                    {sceneChoices.length === 0 && (
                      <p className="text-ink-faint text-sm">
                        No choices on this scene yet.
                      </p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-ink-faint text-center py-20">
                Select a scene to edit.
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
