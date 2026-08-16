import { describe, expect, it } from "vitest";
import { calculateRoadmapHealth } from "@/lib/advisor/health";

/** Phase 16 §40, §57 — deterministic roadmap health, pure function. */
describe("calculateRoadmapHealth", () => {
  const startDate = new Date("2026-08-01T00:00:00Z");
  const endDate = new Date("2026-08-31T00:00:00Z"); // 30-day window

  it("returns INSUFFICIENT_DATA when there are no items at all", () => {
    const result = calculateRoadmapHealth({ startDate, endDate, now: new Date("2026-08-16T00:00:00Z"), actualProgressPercent: 0, totalItems: 0 });
    expect(result.health).toBe("INSUFFICIENT_DATA");
    expect(result.expectedProgressPercent).toBeNull();
  });

  it("returns INSUFFICIENT_DATA when the roadmap has no end date", () => {
    const result = calculateRoadmapHealth({ startDate, endDate: null, now: new Date("2026-08-16T00:00:00Z"), actualProgressPercent: 0.3, totalItems: 5 });
    expect(result.health).toBe("INSUFFICIENT_DATA");
  });

  it("returns INSUFFICIENT_DATA before the minimum elapsed-time ratio has passed", () => {
    const result = calculateRoadmapHealth({ startDate, endDate, now: new Date("2026-08-01T06:00:00Z"), actualProgressPercent: 0, totalItems: 5 });
    expect(result.health).toBe("INSUFFICIENT_DATA");
  });

  it("reports ON_TRACK when actual progress is at or ahead of expected progress", () => {
    // Halfway through the window (day 15/30), actual progress matches or exceeds ~50%.
    const result = calculateRoadmapHealth({ startDate, endDate, now: new Date("2026-08-16T00:00:00Z"), actualProgressPercent: 0.55, totalItems: 10 });
    expect(result.health).toBe("ON_TRACK");
  });

  it("reports AT_RISK when actual progress trails expected by a moderate margin", () => {
    const result = calculateRoadmapHealth({ startDate, endDate, now: new Date("2026-08-16T00:00:00Z"), actualProgressPercent: 0.3, totalItems: 10 });
    expect(result.health).toBe("AT_RISK");
  });

  it("reports BEHIND when actual progress trails expected by a large margin", () => {
    const result = calculateRoadmapHealth({ startDate, endDate, now: new Date("2026-08-16T00:00:00Z"), actualProgressPercent: 0.05, totalItems: 10 });
    expect(result.health).toBe("BEHIND");
  });
});
