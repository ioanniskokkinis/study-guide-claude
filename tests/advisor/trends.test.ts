import { describe, expect, it } from "vitest";
import { calculatePerformanceTrend } from "@/lib/advisor/trends";

/** Phase 16 §5-6, §57 — deterministic performance trend, pure function, no DB. */
describe("calculatePerformanceTrend", () => {
  it("returns INSUFFICIENT_DATA with fewer than TREND_MIN_OBSERVATIONS scores", () => {
    const result = calculatePerformanceTrend([0.2, 0.3, 0.4]);
    expect(result.trend).toBe("INSUFFICIENT_DATA");
    expect(result.recentAverage).toBeNull();
    expect(result.priorAverage).toBeNull();
  });

  it("returns INSUFFICIENT_DATA for zero observations", () => {
    expect(calculatePerformanceTrend([]).trend).toBe("INSUFFICIENT_DATA");
  });

  it("detects DECLINING when the recent window drops well below the prior window", () => {
    const result = calculatePerformanceTrend([0.9, 0.9, 0.9, 0.9, 0.3, 0.3, 0.3]);
    expect(result.trend).toBe("DECLINING");
    expect(result.recentAverage).toBeLessThan(result.priorAverage!);
  });

  it("detects IMPROVING when the recent window rises well above the prior window", () => {
    const result = calculatePerformanceTrend([0.2, 0.2, 0.2, 0.2, 0.9, 0.9, 0.9]);
    expect(result.trend).toBe("IMPROVING");
    expect(result.recentAverage).toBeGreaterThan(result.priorAverage!);
  });

  it("returns STABLE when the delta between windows is within the significant-delta threshold", () => {
    const result = calculatePerformanceTrend([0.5, 0.5, 0.5, 0.5, 0.55, 0.5, 0.52]);
    expect(result.trend).toBe("STABLE");
  });

  it("is a pure function — same input always yields the same output", () => {
    const scores = [0.4, 0.6, 0.3, 0.7, 0.2, 0.9];
    expect(calculatePerformanceTrend(scores)).toEqual(calculatePerformanceTrend(scores));
  });
});
