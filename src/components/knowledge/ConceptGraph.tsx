"use client";

import { useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import Link from "next/link";
import { computeLayeredLayout, type GraphEdge, type GraphNode } from "@/lib/knowledge/graph-layout";

const EDGE_COLORS: Record<string, string> = {
  prerequisite: "#dc2626",
  contains: "#2563eb",
  related: "#6b7280",
  example_of: "#059669",
  contrasts_with: "#d97706",
  causes: "#7c3aed",
  part_of: "#0891b2",
  applies_to: "#4338ca",
};

export function ConceptGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const layoutNodes = useMemo(() => computeLayeredLayout(nodes, edges), [nodes, edges]);
  const positionById = useMemo(() => new Map(layoutNodes.map((node) => [node.id, node])), [layoutNodes]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const dragState = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const width = Math.max(600, ...layoutNodes.map((node) => node.x + 160), 1);
  const height = Math.max(400, ...layoutNodes.map((node) => node.y + 80), 1);

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    setTransform((current) => ({
      ...current,
      scale: Math.min(2, Math.max(0.4, current.scale - event.deltaY * 0.001)),
    }));
  }

  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    dragState.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    setIsDragging(true);
  }

  function handleMouseMove(event: MouseEvent<HTMLDivElement>) {
    if (!dragState.current) {
      return;
    }
    const dx = event.clientX - dragState.current.startX;
    const dy = event.clientY - dragState.current.startY;
    setTransform((current) => ({ ...current, x: dragState.current!.originX + dx, y: dragState.current!.originY + dy }));
  }

  function stopDragging() {
    dragState.current = null;
    setIsDragging(false);
  }

  const selectedNode = selectedId ? positionById.get(selectedId) : null;

  if (nodes.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700">
        No concepts to visualize yet.
      </div>
    );
  }

  return (
    <div>
      <div
        className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
        style={{ height: 420, cursor: isDragging ? "grabbing" : "grab" }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
      >
        <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`}>
          <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
            {edges.map((edge) => {
              const source = positionById.get(edge.sourceId);
              const target = positionById.get(edge.targetId);
              if (!source || !target) {
                return null;
              }
              return (
                <line
                  key={edge.id}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={EDGE_COLORS[edge.relationshipType] ?? "#9ca3af"}
                  strokeWidth={edge.relationshipType === "prerequisite" ? 2 : 1}
                  opacity={0.6}
                />
              );
            })}
            {layoutNodes.map((node) => (
              <g
                key={node.id}
                transform={`translate(${node.x} ${node.y})`}
                onClick={() => setSelectedId(node.id)}
                className="cursor-pointer"
              >
                <circle
                  r={26}
                  fill={selectedId === node.id ? "#18181b" : "#ffffff"}
                  stroke="#18181b"
                  strokeWidth={1.5}
                />
                <text textAnchor="middle" dy={4} fontSize={10} fill={selectedId === node.id ? "#ffffff" : "#18181b"}>
                  {node.name.length > 12 ? `${node.name.slice(0, 11)}…` : node.name}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        {Object.entries(EDGE_COLORS).map(([type, color]) => (
          <span key={type} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            {type}
          </span>
        ))}
      </div>

      {selectedNode && (
        <div className="mt-3 flex items-center justify-between rounded-md border border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
          <span className="font-medium text-zinc-900 dark:text-zinc-50">{selectedNode.name}</span>
          <Link href={`/concepts/${selectedNode.id}`} className="underline underline-offset-2">
            View details
          </Link>
        </div>
      )}
    </div>
  );
}
