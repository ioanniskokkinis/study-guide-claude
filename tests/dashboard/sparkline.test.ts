import { describe, expect, it } from "vitest";
import { buildSparklinePath, buildWeeklyMasteryTrend } from "@/lib/dashboard/sparkline";

const NOW = new Date("2026-08-15T12:00:00Z");

describe("buildWeeklyMasteryTrend", () => {
  it("returns exactly `weeks` buckets, oldest first, ending with the current week", () => {
    const trend = buildWeeklyMasteryTrend([], 8, NOW);
    expect(trend).toHaveLength(8);
    expect(trend[7].weekStart.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it("weeks with no evidence come back null, not zero", () => {
    const trend = buildWeeklyMasteryTrend([], 4, NOW);
    expect(trend.every((p) => p.averageScore === null)).toBe(true);
  });

  it("averages scores that fall within the same week", () => {
    const evidence = [
      { score: 0.8, createdAt: NOW },
      { score: 0.4, createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
    ];
    const trend = buildWeeklyMasteryTrend(evidence, 1, NOW);
    expect(trend[0].averageScore).toBeCloseTo(0.6, 5);
    expect(trend[0].sampleCount).toBe(2);
  });

  it("places older evidence into an earlier bucket than recent evidence", () => {
    const evidence = [
      { score: 0.2, createdAt: new Date(NOW.getTime() - 6 * 7 * 24 * 60 * 60 * 1000) }, // ~6 weeks ago
      { score: 0.9, createdAt: NOW },
    ];
    const trend = buildWeeklyMasteryTrend(evidence, 8, NOW);
    const nonNull = trend.filter((p) => p.averageScore != null);
    expect(nonNull.length).toBe(2);
    expect(nonNull[0].averageScore).toBeCloseTo(0.2, 5);
    expect(nonNull[nonNull.length - 1].averageScore).toBeCloseTo(0.9, 5);
  });
});

describe("buildSparklinePath", () => {
  it("returns an empty string for fewer than 2 points", () => {
    expect(buildSparklinePath([], 100, 50)).toBe("");
    expect(buildSparklinePath([0.5], 100, 50)).toBe("");
  });

  it("produces a path starting with M and using L for subsequent connected points", () => {
    const path = buildSparklinePath([0.2, 0.8, 0.5], 100, 50);
    expect(path.startsWith("M")).toBe(true);
    expect(path).toContain("L");
  });

  it("breaks the line (starts a new M) after a null gap instead of interpolating across it", () => {
    const path = buildSparklinePath([0.2, null, 0.8], 100, 50);
    const moveCommands = path.split(" ").filter((token) => token === "M").length;
    expect(moveCommands).toBe(2);
  });

  it("maps a value of 1 to y=0 (top) and 0 to y=height (bottom)", () => {
    const path = buildSparklinePath([1, 0], 100, 50);
    expect(path).toBe("M 0.0,0.0 L 100.0,50.0");
  });
});
