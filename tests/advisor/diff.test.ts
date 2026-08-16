import { describe, expect, it } from "vitest";
import { computeRoadmapDiff, type DiffableItem } from "@/lib/advisor/diff";

/** Phase 16 §27, §60 — deterministic, human-readable roadmap change diff, never a raw DB diff. */
function item(overrides: Partial<DiffableItem>): DiffableItem {
  return {
    conceptId: "concept-1",
    title: "Concept 1",
    estimatedMinutes: 20,
    scheduledDate: new Date("2026-08-20T00:00:00Z"),
    action: "REVIEW",
    isMilestone: false,
    status: "PENDING",
    ...overrides,
  };
}

describe("computeRoadmapDiff", () => {
  it("lists a concept present in the old roadmap but absent from the new one as removed", () => {
    const oldItems = [item({ conceptId: "c1", title: "Old only" })];
    const diff = computeRoadmapDiff(oldItems, []);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]).toContain("Old only");
  });

  it("lists a concept present in the new roadmap but absent from the old one as added", () => {
    const newItems = [item({ conceptId: "c2", title: "New only" })];
    const diff = computeRoadmapDiff([], newItems);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]).toContain("New only");
  });

  it("marks an item as movedEarlier when its scheduled date is pulled forward", () => {
    const oldItems = [item({ conceptId: "c3", title: "Rescheduled", scheduledDate: new Date("2026-08-25T00:00:00Z") })];
    const newItems = [item({ conceptId: "c3", title: "Rescheduled", scheduledDate: new Date("2026-08-18T00:00:00Z") })];
    const diff = computeRoadmapDiff(oldItems, newItems);
    expect(diff.movedEarlier).toEqual(["Rescheduled"]);
    expect(diff.removed).toHaveLength(0);
  });

  it("does not report an unchanged concept as removed, added, or moved", () => {
    const oldItems = [item({ conceptId: "c4", scheduledDate: new Date("2026-08-20T00:00:00Z") })];
    const newItems = [item({ conceptId: "c4", scheduledDate: new Date("2026-08-20T00:00:00Z") })];
    const diff = computeRoadmapDiff(oldItems, newItems);
    expect(diff).toEqual({ removed: [], movedEarlier: [], added: [] });
  });

  it("excludes already-COMPLETED old items from removed — completed work is carried forward, not reported as lost", () => {
    const oldItems = [item({ conceptId: "c5", status: "COMPLETED" })];
    const diff = computeRoadmapDiff(oldItems, []);
    expect(diff.removed).toHaveLength(0);
  });

  it("excludes milestones from every bucket", () => {
    const oldItems = [item({ conceptId: null, isMilestone: true })];
    const newItems = [item({ conceptId: null, isMilestone: true })];
    const diff = computeRoadmapDiff(oldItems, newItems);
    expect(diff).toEqual({ removed: [], movedEarlier: [], added: [] });
  });
});
