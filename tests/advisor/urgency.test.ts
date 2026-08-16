import { describe, expect, it } from "vitest";
import { calculateUrgency } from "@/lib/advisor/urgency";

/** Phase 16 §9-10, §57 — deterministic deadline urgency + capacity check, pure function. */
describe("calculateUrgency", () => {
  const now = new Date("2026-08-16T00:00:00Z");

  it("scores CRITICAL urgency within the critical-days band", () => {
    const result = calculateUrgency({ now, deadline: new Date("2026-08-18T00:00:00Z"), requiredMinutes: 60, availableMinutes: 200 });
    expect(result.urgencyScore).toBe(1.0);
    expect(result.daysRemaining).toBeCloseTo(2, 0);
  });

  it("scores lower urgency further from the deadline", () => {
    const near = calculateUrgency({ now, deadline: new Date("2026-08-18T00:00:00Z"), requiredMinutes: 60, availableMinutes: 200 });
    const far = calculateUrgency({ now, deadline: new Date("2026-09-16T00:00:00Z"), requiredMinutes: 60, availableMinutes: 200 });
    expect(far.urgencyScore).toBeLessThan(near.urgencyScore);
  });

  it("scores normal urgency when there is no deadline at all", () => {
    const result = calculateUrgency({ now, deadline: null, requiredMinutes: 60, availableMinutes: 200 });
    expect(result.urgencyScore).toBe(0.25);
    expect(result.daysRemaining).toBeNull();
  });

  it("flags insufficientTime when required minutes exceed available minutes", () => {
    const result = calculateUrgency({ now, deadline: new Date("2026-08-18T00:00:00Z"), requiredMinutes: 500, availableMinutes: 100 });
    expect(result.insufficientTime).toBe(true);
  });

  it("does not flag insufficientTime when there is enough capacity", () => {
    const result = calculateUrgency({ now, deadline: new Date("2026-08-30T00:00:00Z"), requiredMinutes: 100, availableMinutes: 500 });
    expect(result.insufficientTime).toBe(false);
  });

  it("clamps daysRemaining to zero for a deadline already in the past", () => {
    const result = calculateUrgency({ now, deadline: new Date("2026-08-01T00:00:00Z"), requiredMinutes: 60, availableMinutes: 200 });
    expect(result.daysRemaining).toBe(0);
    expect(result.urgencyScore).toBe(1.0);
  });
});
