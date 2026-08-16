import { describe, expect, it } from "vitest";
import { calculateTimeBudget } from "@/lib/advisor/time-budget";

/** Phase 15 §29 — deterministic study-time arithmetic; never the AI's job. */
describe("calculateTimeBudget", () => {
  it("computes total minutes as minutesPerDay × every day in range when studyDays is empty", () => {
    const startDate = new Date("2026-01-01T00:00:00Z");
    const endDate = new Date("2026-01-07T00:00:00Z"); // 7 days inclusive
    const budget = calculateTimeBudget({ minutesPerDay: 30, studyDays: [], startDate, endDate });
    expect(budget.totalStudyDays).toBe(7);
    expect(budget.totalMinutes).toBe(210);
  });

  it("only counts the configured weekdays", () => {
    // 2026-01-01 is a Thursday (day=4). Restricting to Mon/Wed/Fri (1,3,5) over 14 days should yield 6 study days.
    const startDate = new Date("2026-01-01T00:00:00Z");
    const endDate = new Date("2026-01-14T00:00:00Z");
    const budget = calculateTimeBudget({ minutesPerDay: 20, studyDays: [1, 3, 5], startDate, endDate });
    for (const week of budget.weeks) {
      for (const date of week.studyDates) {
        expect([1, 3, 5]).toContain(date.getDay());
      }
    }
    expect(budget.totalMinutes).toBe(budget.totalStudyDays * 20);
  });

  it("splits the range into 7-day weeks with per-week available minutes", () => {
    const startDate = new Date("2026-01-01T00:00:00Z");
    const endDate = new Date("2026-01-14T00:00:00Z"); // 14 days -> 2 weeks
    const budget = calculateTimeBudget({ minutesPerDay: 60, studyDays: [], startDate, endDate });
    expect(budget.weeks).toHaveLength(2);
    expect(budget.weeks[0].weekNumber).toBe(1);
    expect(budget.weeks[1].weekNumber).toBe(2);
    const sumOfWeeks = budget.weeks.reduce((sum, w) => sum + w.availableMinutes, 0);
    expect(sumOfWeeks).toBe(budget.totalMinutes);
  });

  it("returns a single day/week for a same-day start and end", () => {
    const date = new Date("2026-03-01T00:00:00Z");
    const budget = calculateTimeBudget({ minutesPerDay: 45, studyDays: [], startDate: date, endDate: date });
    expect(budget.totalStudyDays).toBe(1);
    expect(budget.totalMinutes).toBe(45);
    expect(budget.weeks).toHaveLength(1);
  });
});
