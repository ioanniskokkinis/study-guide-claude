import type { ReviewOutcome } from "@/generated/prisma/client";

/**
 * All tunable constants for the spaced-repetition scheduler, in one place
 * (spec §6: "do not scatter magic numbers throughout the codebase"). Every
 * function in scheduler.ts reads from here rather than embedding a number
 * inline.
 */

/** Starting difficulty for a brand-new ReviewItem, on the same 1-5 scale used everywhere else in the app (Concept/Question/ExamQuestion difficulty). */
export const INITIAL_DIFFICULTY = 3;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 5;

/** How much each outcome shifts difficulty (spec §6) — AGAIN/HARD push it up (harder), EASY pulls it down, clamped to [MIN_DIFFICULTY, MAX_DIFFICULTY]. */
export const DIFFICULTY_DELTA: Record<ReviewOutcome, number> = {
  AGAIN: 0.8,
  HARD: 0.3,
  GOOD: -0.1,
  EASY: -0.4,
};

/** Consecutive successful reviews needed to graduate LEARNING/RELEARNING -> REVIEW. */
export const GRADUATION_REPS = 2;

/** Seed stability (days) for a review item's very first successful rating, or the first rating after `stability` has decayed to 0 — before that, growth is multiplicative off the previous stability instead (spec §5's "previous interval"). */
export const INITIAL_STABILITY_DAYS: Record<Exclude<ReviewOutcome, "AGAIN">, number> = {
  HARD: 1,
  GOOD: 2,
  EASY: 4,
};

/** Multiplier applied to the previous stability on a successful (non-AGAIN) review, before difficulty/mastery/performance modulation (spec §6: "GOOD -> normal interval increase", "EASY -> larger interval increase"). */
export const BASE_GROWTH_MULTIPLIER: Record<Exclude<ReviewOutcome, "AGAIN">, number> = {
  HARD: 1.35,
  GOOD: 2.0,
  EASY: 2.8,
};

/** AGAIN shrinks (never fully resets) stability, so a lapsed item that had been reviewed for months recovers faster than a brand-new one (spec §6: "AGAIN -> reset/reduce interval"). */
export const LAPSE_STABILITY_RETENTION = 0.2;
export const MIN_STABILITY_AFTER_LAPSE_DAYS = 0.5;
/** An AGAIN rating is always due again the next day, regardless of prior stability. */
export const LAPSE_RELEARN_INTERVAL_DAYS = 1;

export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 180;

/** Difficulty modulates growth: difficulty MIN_DIFFICULTY grows fastest, MAX_DIFFICULTY grows slowest. */
export const DIFFICULTY_GROWTH_FACTOR_AT_MIN = 1.15;
export const DIFFICULTY_GROWTH_FACTOR_AT_MAX = 0.6;

/** Bounds for the current-mastery / recent-recall-performance modulation (spec §5) — a supporting signal, never the primary driver (the outcome rating is). */
export const PERFORMANCE_ADJUSTMENT_MIN = 0.75;
export const PERFORMANCE_ADJUSTMENT_MAX = 1.25;
export const MASTERY_ADJUSTMENT_WEIGHT = 0.3;
export const PERFORMANCE_ADJUSTMENT_WEIGHT = 0.2;

/** A freshly-created ReviewItem (a concept just studied for the first time elsewhere) becomes due starting tomorrow, not immediately — it was just taught moments ago. */
export const INITIAL_ONSET_DAYS = 1;

/** How many due items a single review session targets at most (spec §13 "basic review session"). */
export const MAX_REVIEW_SESSION_SIZE = 20;

/** How far back review-streak calculation looks for consecutive reviewed days (spec §16). */
export const STREAK_LOOKBACK_DAYS = 60;
