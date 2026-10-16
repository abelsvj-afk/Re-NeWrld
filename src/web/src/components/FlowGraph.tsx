import { useMemo } from 'react';
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { SceneSummary, ChoiceSummary } from '../lib/api';

interface FlowGraphProps {
  scenes: SceneSummary[];
  choices: ChoiceSummary[];
  activeSceneId: string | null;
  startSceneId: string | null;
  onSelectScene: (sceneId: string) => void;
}

/**
 * Branching graph visualizer (US-C13). Renders scenes as nodes and choices
 * as edges. Click a node to jump to that scene in the editor.
 */
export function FlowGraph({ scenes, choices, activeSceneId, startSceneId, onSelectScene }: FlowGraphProps) {
  const { nodes, edges } = useMemo(() => {
    // Simple layered layout: BFS from start scene (or first scene)
    const startId = startSceneId ?? scenes[0]?.id;
    const layers: string[][] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = startId ? [{ id: startId, depth: 0 }] : [];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (!layers[depth]) layers[depth] = [];
      layers[depth].push(id);
      const outgoing = choices.filter((c) => c.sceneId === id);
      for (const c of outgoing) {
        if (!visited.has(c.targetSceneId)) {
          queue.push({ id: c.targetSceneId, depth: depth + 1 });
        }
      }
    }

    // Add orphaned scenes (not reachable) in a final layer
    const orphaned = scenes.filter((s) => !visited.has(s.id));
    if (orphaned.length > 0) {
      layers.push(orphaned.map((s) => s.id));
    }

    const nodes: Node[] = [];
    layers.forEach((layer, depth) => {
      layer.forEach((sceneId, idx) => {
        const scene = scenes.find((s) => s.id === sceneId);
        if (!scene) return;
        const isStart = sceneId === startSceneId;
        const isActive = sceneId === activeSceneId;
        const isEnding = !!scene.isEnding;
        const isOrphaned = depth === layers.length - 1 && orphaned.length > 0 && orphaned.some((s) => s.id === sceneId);

        nodes.push({
          id: sceneId,
          position: { x: depth * 260, y: idx * 120 - (layer.length * 60) },
          data: { label: scene.title },
          style: {
            background: isActive ? 'rgba(34, 211, 238, 0.15)' : isEnding ? 'rgba(249, 115, 22, 0.1)' : 'rgba(30, 41, 59, 0.9)',
            border: isActive ? '2px solid #22d3ee' : isStart ? '2px solid #34d399' : isEnding ? '2px solid #f97316' : '1px solid #334155',
            borderRadius: '12px',
            padding: '12px 16px',
            color: '#e2e8f0',
            fontSize: '13px',
            fontWeight: isActive ? 600 : 400,
            minWidth: '160px',
            maxWidth: '200px',
            opacity: isOrphaned ? 0.5 : 1,
          },
        });
      });
    });

    const edges: Edge[] = choices.map((c, i) => ({
      id: `e-${c.id}-${i}`,
      source: c.sceneId,
      target: c.targetSceneId,
      label: c.text.length > 24 ? c.text.slice(0, 24) + '…' : c.text,
      style: { stroke: '#475569', strokeWidth: 1.5 },
      labelStyle: { fontSize: '10px', fill: '#94a3b8' },
      labelBgStyle: { fill: '#0f172a', fillOpacity: 0.9 },
    }));

    return { nodes, edges };
  }, [scenes, choices, activeSceneId, startSceneId]);

  if (scenes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-ink-faint">
        <p>No scenes yet. Create a scene to see the graph.</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full" style={{ minHeight: '500px' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, node) => onSelectScene(node.id)}
        fitView
        attributionPosition="bottom-left"
      >
        <Background color="#1e293b" gap={24} />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            const scene = scenes.find((s) => s.id === n.id);
            if (scene?.isEnding) return '#f97316';
            if (n.id === startSceneId) return '#34d399';
            return '#475569';
          }}
          maskColor="rgba(0, 0, 0, 0.7)"
        />
      </ReactFlow>
      <div className="absolute bottom-4 left-4 flex gap-4 text-[11px] text-ink-faint bg-abyss/80 backdrop-blur px-3 py-2 rounded-lg border border-edge/60">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" /> Start</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" /> Ending</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-slate-500 inline-block opacity-50" /> Unreachable</span>
      </div>
    </div>
  );
}
