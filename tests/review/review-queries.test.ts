import { describe, expect, it } from "vitest";
import { isDue, overdueDays } from "@/lib/review/review-queries";

const NOW = new Date("2026-08-15T12:00:00Z");

describe("isDue / overdueDays — the one canonical due-state definition (spec §7)", () => {
  it("an item scheduled for exactly now is due", () => {
    expect(isDue({ nextReviewAt: NOW }, NOW)).toBe(true);
  });

  it("an item scheduled in the past is due", () => {
    const past = new Date(NOW.getTime() - 60_000);
    expect(isDue({ nextReviewAt: past }, NOW)).toBe(true);
  });

  it("an item scheduled in the future is not due", () => {
    const future = new Date(NOW.getTime() + 60_000);
    expect(isDue({ nextReviewAt: future }, NOW)).toBe(false);
  });

  it("overdueDays is 0 for a not-yet-due item", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(overdueDays({ nextReviewAt: future }, NOW)).toBe(0);
  });

  it("overdueDays is 0 for an item due exactly now", () => {
    expect(overdueDays({ nextReviewAt: NOW }, NOW)).toBe(0);
  });

  it("overdueDays reports the correct fractional day count for a past-due item", () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    expect(overdueDays({ nextReviewAt: twoDaysAgo }, NOW)).toBeCloseTo(2, 5);
  });

  it("overdueDays is never negative", () => {
    const future = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    expect(overdueDays({ nextReviewAt: future }, NOW)).toBeGreaterThanOrEqual(0);
  });
});
