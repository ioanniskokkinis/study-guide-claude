import type { ReviewItemStatus, ReviewOutcome } from "@/generated/prisma/client";
import {
  BASE_GROWTH_MULTIPLIER,
  DIFFICULTY_DELTA,
  DIFFICULTY_GROWTH_FACTOR_AT_MAX,
  DIFFICULTY_GROWTH_FACTOR_AT_MIN,
  GRADUATION_REPS,
  INITIAL_STABILITY_DAYS,
  LAPSE_RELEARN_INTERVAL_DAYS,
  LAPSE_STABILITY_RETENTION,
  MASTERY_ADJUSTMENT_WEIGHT,
  MAX_DIFFICULTY,
  MAX_INTERVAL_DAYS,
  MIN_DIFFICULTY,
  MIN_INTERVAL_DAYS,
  MIN_STABILITY_AFTER_LAPSE_DAYS,
  PERFORMANCE_ADJUSTMENT_MAX,
  PERFORMANCE_ADJUSTMENT_MIN,
  PERFORMANCE_ADJUSTMENT_WEIGHT,
} from "./config";

/**
 * The deterministic spaced-repetition scheduler (spec §5). Claude is never
 * involved anywhere in this file — every review date is computed from the
 * item's own history, the student's self-rated outcome, and (as bounded
 * supporting signals, not the primary driver) current mastery and recent
 * recall performance from the Student Knowledge Model (spec §5, §8).
 *
 * Two numbers are tracked, on purpose (spec §3): `stability` is the
 * scheduler's current estimate, in days, of how long this memory will hold
 * before it needs reinforcing; `interval` is the schedule gap actually
 * applied (derived from stability, kept separate so future tuning — fuzz,
 * per-mode caps — can diverge them without touching this shape).
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Difficulty MIN_DIFFICULTY (easiest) grows fastest; MAX_DIFFICULTY (hardest) grows slowest — linear interpolation between the two configured bounds. */
export function difficultyGrowthFactor(difficulty: number): number {
  const t = clamp((difficulty - MIN_DIFFICULTY) / (MAX_DIFFICULTY - MIN_DIFFICULTY), 0, 1);
  return DIFFICULTY_GROWTH_FACTOR_AT_MIN + t * (DIFFICULTY_GROWTH_FACTOR_AT_MAX - DIFFICULTY_GROWTH_FACTOR_AT_MIN);
}

/**
 * Bounded modulation from current mastery (spec §5) and recent recall
 * performance (spec §5) — both 0-1, defaulting to neutral (0.5) when
 * unknown. This never dominates the outcome-driven mechanics below; it only
 * nudges growth within [PERFORMANCE_ADJUSTMENT_MIN, PERFORMANCE_ADJUSTMENT_MAX].
 */
export function performanceAdjustment(studentMastery: number | null | undefined, recentPerformance: number | null | undefined): number {
  const mastery = studentMastery ?? 0.5;
  const performance = recentPerformance ?? 0.5;
  const raw = 1 + (mastery - 0.5) * MASTERY_ADJUSTMENT_WEIGHT + (performance - 0.5) * PERFORMANCE_ADJUSTMENT_WEIGHT;
  return clamp(raw, PERFORMANCE_ADJUSTMENT_MIN, PERFORMANCE_ADJUSTMENT_MAX);
}

export interface ReviewItemSnapshot {
  status: ReviewItemStatus;
  interval: number;
  stability: number;
  difficulty: number;
  repetitionCount: number;
  lapseCount: number;
}

export interface ScheduleReviewInput {
  reviewItem: ReviewItemSnapshot;
  outcome: ReviewOutcome;
  /** 0-1 current overall mastery for this concept (Phase 4's Student Knowledge Model), or null/undefined if unknown. */
  studentMastery?: number | null;
  /** 0-1 recent recall success rate for this concept (e.g. average of the last few LearningAttempt scores — already includes exam/tutor evidence, spec §12), or null/undefined if unknown. */
  recentPerformance?: number | null;
  now?: Date;
}

export interface ScheduleReviewOutput {
  status: ReviewItemStatus;
  interval: number;
  stability: number;
  difficulty: number;
  repetitionCount: number;
  lapseCount: number;
  nextReviewAt: Date;
}

/**
 * Computes the next review state from the previous state, the previous
 * interval, the self-rated outcome, difficulty, repetition/lapse counts,
 * current mastery, and recent recall performance — every factor spec §5
 * asks for. Pure and deterministic: same input, same output, always.
 */
export function scheduleReview(input: ScheduleReviewInput): ScheduleReviewOutput {
  const { reviewItem, outcome } = input;
  const now = input.now ?? new Date();
  const difficulty = clamp(reviewItem.difficulty + DIFFICULTY_DELTA[outcome], MIN_DIFFICULTY, MAX_DIFFICULTY);

  if (outcome === "AGAIN") {
    const stability = Math.max(MIN_STABILITY_AFTER_LAPSE_DAYS, reviewItem.stability * LAPSE_STABILITY_RETENTION);
    const interval = LAPSE_RELEARN_INTERVAL_DAYS;
    const status: ReviewItemStatus = reviewItem.status === "NEW" ? "LEARNING" : "RELEARNING";
    return {
      status,
      interval,
      stability,
      difficulty,
      repetitionCount: 0,
      lapseCount: reviewItem.lapseCount + 1,
      nextReviewAt: addDays(now, interval),
    };
  }

  const adjustment = performanceAdjustment(input.studentMastery, input.recentPerformance);

  let stability: number;
  if (reviewItem.status === "NEW" || reviewItem.stability <= 0) {
    // First-ever successful rating, or recovering from a total reset: seed from the outcome table.
    stability = INITIAL_STABILITY_DAYS[outcome] * adjustment;
  } else {
    // Otherwise grow multiplicatively off the item's own previous stability (spec §5's "previous interval").
    stability = reviewItem.stability * BASE_GROWTH_MULTIPLIER[outcome] * difficultyGrowthFactor(difficulty) * adjustment;
  }
  stability = clamp(stability, MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS);
  const interval = Math.round(stability * 10) / 10;

  const repetitionCount = reviewItem.repetitionCount + 1;
  const status: ReviewItemStatus = repetitionCount >= GRADUATION_REPS ? "REVIEW" : "LEARNING";

  return {
    status,
    interval,
    stability,
    difficulty,
    repetitionCount,
    lapseCount: reviewItem.lapseCount,
    nextReviewAt: addDays(now, interval),
  };
}

export { addDays };
