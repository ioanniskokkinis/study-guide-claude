import { describe, expect, it } from "vitest";
import { computeLayeredLayout } from "@/lib/knowledge/graph-layout";

describe("computeLayeredLayout", () => {
  it("places a prerequisite chain in strictly increasing columns", () => {
    const nodes = [
      { id: "a", name: "TCP/IP", difficulty: 1 },
      { id: "b", name: "TCP", difficulty: 2 },
      { id: "c", name: "Ports", difficulty: 2 },
    ];
    const edges = [
      { id: "e1", sourceId: "a", targetId: "b", relationshipType: "prerequisite" },
      { id: "e2", sourceId: "b", targetId: "c", relationshipType: "prerequisite" },
    ];

    const layout = computeLayeredLayout(nodes, edges);
    const byId = new Map(layout.map((node) => [node.id, node]));

    expect(byId.get("a")!.x).toBeLessThan(byId.get("b")!.x);
    expect(byId.get("b")!.x).toBeLessThan(byId.get("c")!.x);
  });

  it("does not let a non-prerequisite edge affect column placement", () => {
    const nodes = [
      { id: "a", name: "TCP", difficulty: 2 },
      { id: "b", name: "UDP", difficulty: 2 },
    ];
    const edges = [{ id: "e1", sourceId: "a", targetId: "b", relationshipType: "contrasts_with" }];

    const layout = computeLayeredLayout(nodes, edges);
    expect(layout[0].x).toBe(layout[1].x);
  });

  it("places nodes with no prerequisite edges in the first column", () => {
    const nodes = [{ id: "a", name: "Isolated", difficulty: 1 }];
    const layout = computeLayeredLayout(nodes, []);
    expect(layout[0].x).toBe(80);
  });

  it("handles an empty graph without throwing", () => {
    expect(() => computeLayeredLayout([], [])).not.toThrow();
    expect(computeLayeredLayout([], [])).toEqual([]);
  });
});
