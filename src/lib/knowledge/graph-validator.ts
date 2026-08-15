/**
 * Validates AI-proposed graph edges before they're persisted. Operates on
 * concept names rather than DB IDs so it can run before concepts are
 * written to the database (see knowledge-builder.ts) — the whole candidate
 * graph is validated in memory, then persisted in one transaction.
 */

export interface NamedEdgeCandidate {
  sourceName: string;
  targetName: string;
  edgeType: string;
  confidence: number;
  evidence: string;
}

export interface ValidatedEdge extends NamedEdgeCandidate {
  needsReview: boolean;
}

export interface EdgeValidationResult {
  accepted: ValidatedEdge[];
  rejected: { edge: NamedEdgeCandidate; reason: string }[];
}

export interface ConfidenceThresholds {
  autoAccept: number;
  reviewFloor: number;
}

/**
 * Rejects self-references, edges to unknown concepts, duplicate edges
 * (same source/target/type), and confidence below `reviewFloor`. Edges
 * between `reviewFloor` and `autoAccept` are accepted but flagged
 * `needsReview` (spec §15).
 */
export function validateEdges(
  candidates: NamedEdgeCandidate[],
  knownConceptNames: Set<string>,
  thresholds: ConfidenceThresholds,
): EdgeValidationResult {
  const accepted: ValidatedEdge[] = [];
  const rejected: { edge: NamedEdgeCandidate; reason: string }[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.sourceName === candidate.targetName) {
      rejected.push({ edge: candidate, reason: "self-reference" });
      continue;
    }
    if (!knownConceptNames.has(candidate.sourceName) || !knownConceptNames.has(candidate.targetName)) {
      rejected.push({ edge: candidate, reason: "references an unknown concept" });
      continue;
    }

    const key = `${candidate.sourceName}|${candidate.targetName}|${candidate.edgeType}`;
    if (seen.has(key)) {
      rejected.push({ edge: candidate, reason: "duplicate edge" });
      continue;
    }

    if (candidate.confidence < thresholds.reviewFloor) {
      rejected.push({ edge: candidate, reason: "confidence below acceptance threshold" });
      continue;
    }

    seen.add(key);
    accepted.push({ ...candidate, needsReview: candidate.confidence < thresholds.autoAccept });
  }

  return { accepted, rejected };
}

export interface NamedPrerequisiteEdge {
  prerequisiteName: string;
  dependentName: string;
}

/**
 * Prerequisite edges must form a DAG (spec §6). Accepts edges in order,
 * skipping any edge that would close a cycle in the accumulated graph
 * (prerequisite -> dependent) — detected, not silently created.
 */
export function filterAcyclicPrerequisites<T extends NamedPrerequisiteEdge>(
  edges: T[],
): { accepted: T[]; rejectedCycles: T[] } {
  const adjacency = new Map<string, Set<string>>();
  const accepted: T[] = [];
  const rejectedCycles: T[] = [];

  function wouldCreateCycle(from: string, to: string): boolean {
    if (from === to) {
      return true;
    }
    const visited = new Set<string>();
    const stack = [to];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === from) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      const next = adjacency.get(current);
      if (next) {
        for (const neighbor of next) {
          stack.push(neighbor);
        }
      }
    }
    return false;
  }

  for (const edge of edges) {
    if (wouldCreateCycle(edge.prerequisiteName, edge.dependentName)) {
      rejectedCycles.push(edge);
      continue;
    }
    accepted.push(edge);
    if (!adjacency.has(edge.prerequisiteName)) {
      adjacency.set(edge.prerequisiteName, new Set());
    }
    adjacency.get(edge.prerequisiteName)?.add(edge.dependentName);
  }

  return { accepted, rejectedCycles };
}
