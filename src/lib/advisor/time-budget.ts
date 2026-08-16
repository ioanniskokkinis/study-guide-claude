import { addDays } from "@/lib/review/scheduler";

/**
 * Deterministic study-time budgeting (Phase 15 §29). The AI never decides
 * how many minutes exist to allocate — this pure function is the only
 * source of truth for that arithmetic, and every generated plan is later
 * clamped against it (see roadmap-generator.ts) so a plan can never exceed
 * what the student actually said they have available.
 */

export interface TimeBudgetInput {
  /** Minutes/day the student can study. */
  minutesPerDay: number;
  /** Weekday indices (0=Sunday..6=Saturday) the student is available. Empty means every day. */
  studyDays: number[];
  startDate: Date;
  /** Inclusive. */
  endDate: Date;
}

export interface WeekBudget {
  weekNumber: number;
  startDate: Date;
  endDate: Date;
  /** The actual calendar dates within this week that count as study days. */
  studyDates: Date[];
  availableMinutes: number;
}

export interface TimeBudget {
  totalStudyDays: number;
  totalMinutes: number;
  weeks: WeekBudget[];
}

function atMidnight(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function calculateTimeBudget(input: TimeBudgetInput): TimeBudget {
  const allowedWeekdays = input.studyDays.length > 0 ? new Set(input.studyDays) : new Set([0, 1, 2, 3, 4, 5, 6]);
  const end = atMidnight(input.endDate);

  const weeks: WeekBudget[] = [];
  let cursor = atMidnight(input.startDate);
  let weekNumber = 1;
  let totalStudyDays = 0;

  while (cursor <= end) {
    const weekStart = cursor;
    const studyDates: Date[] = [];
    let lastDayInWeek = cursor;

    for (let i = 0; i < 7 && cursor <= end; i++) {
      if (allowedWeekdays.has(cursor.getDay())) {
        studyDates.push(cursor);
        totalStudyDays++;
      }
      lastDayInWeek = cursor;
      cursor = addDays(cursor, 1);
    }

    weeks.push({
      weekNumber,
      startDate: weekStart,
      endDate: lastDayInWeek,
      studyDates,
      availableMinutes: studyDates.length * input.minutesPerDay,
    });
    weekNumber++;
  }

  return { totalStudyDays, totalMinutes: totalStudyDays * input.minutesPerDay, weeks };
}
