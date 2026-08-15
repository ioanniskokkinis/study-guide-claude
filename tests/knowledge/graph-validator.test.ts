import { describe, expect, it } from "vitest";
import { filterAcyclicPrerequisites, validateEdges } from "@/lib/knowledge/graph-validator";

describe("validateEdges", () => {
  const known = new Set(["TCP", "Ports", "Firewalls"]);
  const thresholds = { autoAccept: 0.85, reviewFloor: 0.6 };

  it("rejects self-references", () => {
    const result = validateEdges(
      [{ sourceName: "TCP", targetName: "TCP", edgeType: "related", confidence: 0.9, evidence: "..." }],
      known,
      thresholds,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("self-reference");
  });

  it("rejects edges referencing an unknown concept", () => {
    const result = validateEdges(
      [{ sourceName: "TCP", targetName: "Mystery", edgeType: "related", confidence: 0.9, evidence: "..." }],
      known,
      thresholds,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/unknown concept/);
  });

  it("deduplicates duplicate edges (same source/target/type)", () => {
    const candidate = { sourceName: "TCP", targetName: "Ports", edgeType: "related", confidence: 0.9, evidence: "..." };
    const result = validateEdges([candidate, { ...candidate }], known, thresholds);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("duplicate edge");
  });

  it("rejects low-confidence edges and flags mid-confidence ones for review", () => {
    const result = validateEdges(
      [
        { sourceName: "TCP", targetName: "Ports", edgeType: "related", confidence: 0.5, evidence: "below floor" },
        { sourceName: "Ports", targetName: "Firewalls", edgeType: "related", confidence: 0.7, evidence: "review band" },
        { sourceName: "TCP", targetName: "Firewalls", edgeType: "related", confidence: 0.95, evidence: "auto accept" },
      ],
      known,
      thresholds,
    );

    expect(result.rejected).toHaveLength(1);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted.find((edge) => edge.confidence === 0.7)?.needsReview).toBe(true);
    expect(result.accepted.find((edge) => edge.confidence === 0.95)?.needsReview).toBe(false);
  });
});

describe("filterAcyclicPrerequisites", () => {
  it("accepts a valid DAG", () => {
    const edges = [
      { prerequisiteName: "TCP/IP", dependentName: "TCP" },
      { prerequisiteName: "TCP", dependentName: "Ports" },
      { prerequisiteName: "Ports", dependentName: "Firewalls" },
    ];
    const { accepted, rejectedCycles } = filterAcyclicPrerequisites(edges);
    expect(accepted).toHaveLength(3);
    expect(rejectedCycles).toHaveLength(0);
  });

  it("detects and rejects a cycle (A -> B -> C -> A) without silently creating it", () => {
    const edges = [
      { prerequisiteName: "A", dependentName: "B" },
      { prerequisiteName: "B", dependentName: "C" },
      { prerequisiteName: "C", dependentName: "A" },
    ];
    const { accepted, rejectedCycles } = filterAcyclicPrerequisites(edges);
    expect(accepted).toHaveLength(2);
    expect(rejectedCycles).toHaveLength(1);
    expect(rejectedCycles[0]).toEqual({ prerequisiteName: "C", dependentName: "A" });
  });

  it("rejects a direct self-referencing edge", () => {
    const { accepted, rejectedCycles } = filterAcyclicPrerequisites([
      { prerequisiteName: "A", dependentName: "A" },
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejectedCycles).toHaveLength(1);
  });
});
