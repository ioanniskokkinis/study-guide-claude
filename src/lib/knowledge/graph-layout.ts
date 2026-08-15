export interface GraphNode {
  id: string;
  name: string;
  difficulty: number;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relationshipType: string;
}

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
}

/**
 * Deterministic layered layout: columns are the concept's longest-path
 * depth in the prerequisite subgraph (root prerequisites at column 0), so
 * the graph reads top-to-bottom/left-to-right the way a prerequisite chain
 * is taught. Concepts with no prerequisite edges land in column 0 too.
 * Not a physics simulation — intentionally simple (spec §21: "do not spend
 * excessive time on visual polish").
 */
export function computeLayeredLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options?: { columnWidth?: number; rowHeight?: number },
): LayoutNode[] {
  const columnWidth = options?.columnWidth ?? 220;
  const rowHeight = options?.rowHeight ?? 90;

  const prerequisiteEdges = edges.filter((edge) => edge.relationshipType === "prerequisite");
  const dependentsOf = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();
  for (const node of nodes) {
    incomingCount.set(node.id, 0);
  }
  for (const edge of prerequisiteEdges) {
    if (!dependentsOf.has(edge.sourceId)) {
      dependentsOf.set(edge.sourceId, []);
    }
    dependentsOf.get(edge.sourceId)?.push(edge.targetId);
    incomingCount.set(edge.targetId, (incomingCount.get(edge.targetId) ?? 0) + 1);
  }

  const depth = new Map<string, number>();
  const remainingIncoming = new Map(incomingCount);
  const queue: string[] = [];
  for (const node of nodes) {
    if ((incomingCount.get(node.id) ?? 0) === 0) {
      depth.set(node.id, 0);
      queue.push(node.id);
    }
  }

  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    const currentDepth = depth.get(current) ?? 0;
    for (const next of dependentsOf.get(current) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, currentDepth + 1));
      const remaining = (remainingIncoming.get(next) ?? 0) - 1;
      remainingIncoming.set(next, remaining);
      if (remaining <= 0) {
        queue.push(next);
      }
    }
  }
  // Any node never reached (shouldn't happen for a validated acyclic
  // prerequisite subgraph, but guard against surprises) defaults to column 0.
  for (const node of nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, 0);
    }
  }

  const columns = new Map<number, string[]>();
  for (const node of nodes) {
    const column = depth.get(node.id) ?? 0;
    if (!columns.has(column)) {
      columns.set(column, []);
    }
    columns.get(column)?.push(node.id);
  }

  const positionById = new Map<string, { x: number; y: number }>();
  const sortedColumns = [...columns.entries()].sort((a, b) => a[0] - b[0]);
  for (const [column, ids] of sortedColumns) {
    ids.forEach((id, row) => {
      positionById.set(id, { x: column * columnWidth + 80, y: row * rowHeight + 60 });
    });
  }

  return nodes.map((node) => {
    const position = positionById.get(node.id) ?? { x: 80, y: 60 };
    return { ...node, ...position };
  });
}
