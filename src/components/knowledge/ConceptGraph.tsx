"use client";

import { useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import Link from "next/link";
import { computeLayeredLayout, type GraphEdge, type GraphNode } from "@/lib/knowledge/graph-layout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

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
    return <EmptyState icon="🕸️" title="No concepts to visualize yet" />;
  }

  return (
    <div>
      <div
        className="transition-standard overflow-hidden rounded-lg border border-border bg-surface-muted"
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
                  fill={selectedId === node.id ? "var(--color-accent)" : "var(--color-surface)"}
                  stroke="var(--color-accent)"
                  strokeWidth={1.5}
                />
                <text
                  textAnchor="middle"
                  dy={4}
                  fontSize={10}
                  fill={selectedId === node.id ? "var(--color-accent-fg)" : "var(--color-fg)"}
                >
                  {node.name.length > 12 ? `${node.name.slice(0, 11)}…` : node.name}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        {Object.entries(EDGE_COLORS).map(([type, color]) => (
          <span key={type} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            {type}
          </span>
        ))}
      </div>

      {selectedNode && (
        <Card padding="sm" className="animate-slide-up mt-3 flex items-center justify-between">
          <span className="font-medium text-fg">{selectedNode.name}</span>
          <Link href={`/concepts/${selectedNode.id}`} className="focus-ring rounded text-sm underline underline-offset-2">
            View details
          </Link>
        </Card>
      )}
    </div>
  );
}
