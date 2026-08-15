import { clamp01 } from "@/lib/learning/mastery-engine";
import {
  CHALLENGE_MASTERY_THRESHOLD,
  CHALLENGE_SUCCESS_STREAK_THRESHOLD,
  MISCONCEPTION_OVERRIDE_SEVERITY,
  MISTAKE_RELEVANCE_WINDOW_DAYS,
  REPEATED_FAILURE_WINDOW_SIZE,
  REVIEW_MASTERY_FLOOR,
} from "./config";
import { calculateReviewUrgencyScore, type ConceptValueBreakdown } from "./concept-scoring";
import type { RecentAttemptInfo, RecentMistakeInfo, StudentLearningState } from "./student-state";

/**
 * Per-action-type scoring (spec §18-22). Each function looks at one
 * concept's already-computed value breakdown plus its recent attempt
 * history and returns 0-1 — the engine (adaptive-engine.ts) compares these
 * across concepts/action-types and picks the highest, it never guesses at
 * a combined formula itself.
 */

const SUCCESS_VALUE_THRESHOLD = 0.7;
const FAILURE_VALUE_THRESHOLD = 0.4;

function outcomeValue(attempt: RecentAttemptInfo): number {
  return attempt.correctness ?? attempt.score ?? 0;
}

/** Weighted toward the most recent attempts within the window — a fresh run of failures counts more than the same failures buried at the back of the window (spec §20). */
export function repeatedFailureScore(
  attempts: RecentAttemptInfo[],
  windowSize: number = REPEATED_FAILURE_WINDOW_SIZE,
): number {
  const window = attempts.slice(0, windowSize);
  if (window.length === 0) return 0;

  let weightedFailures = 0;
  let weightTotal = 0;
  window.forEach((attempt, index) => {
    const weight = windowSize - index;
    weightTotal += weight;
    if (outcomeValue(attempt) < FAILURE_VALUE_THRESHOLD) weightedFailures += weight;
  });

  return clamp01(weightedFailures / weightTotal);
}

/** Count of leading (most-recent-first) successful attempts before the first non-success (spec §21). */
export function successStreak(attempts: RecentAttemptInfo[]): number {
  let streak = 0;
  for (const attempt of attempts) {
    if (outcomeValue(attempt) >= SUCCESS_VALUE_THRESHOLD) streak++;
    else break;
  }
  return streak;
}

/** A recent, high/critical-severity misconception overrides an otherwise-high mastery score (spec §22). */
export function hasSevereMisconception(
  mistakes: RecentMistakeInfo[],
  now: Date = new Date(),
  windowDays: number = MISTAKE_RELEVANCE_WINDOW_DAYS,
): boolean {
  return mistakes.some((mistake) => {
    if (mistake.category !== "MISCONCEPTION") return false;
    if (!(MISCONCEPTION_OVERRIDE_SEVERITY as readonly string[]).includes(mistake.severity)) return false;
    const ageDays = (now.getTime() - mistake.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays <= windowDays;
  });
}

export interface CandidateContext {
  value: ConceptValueBreakdown;
  /** This concept's recent attempts, most-recent-first. */
  attempts: RecentAttemptInfo[];
  hasSevereMisconception: boolean;
  /** 0-1 spaced-repetition due urgency (Phase 9) — 0 when the concept has no ReviewItem yet or isn't due. */
  reviewUrgency: number;
}

export function buildCandidateContext(conceptId: string, value: ConceptValueBreakdown, state: StudentLearningState, now: Date = new Date()): CandidateContext {
  return {
    value,
    attempts: state.recentAttemptsByConceptId.get(conceptId) ?? [],
    hasSevereMisconception: hasSevereMisconception(state.recentMistakesByConceptId.get(conceptId) ?? [], now),
    reviewUrgency: calculateReviewUrgencyScore(conceptId, state),
  };
}

/** Default learning action: weak/developing, no urgent prerequisite problem (spec §19). Halved (not zeroed) when blocked, so it can still surface if prerequisite review somehow scores lower. */
export function scoreActiveRecall(ctx: CandidateContext): number {
  return ctx.value.block.blocked ? clamp01(ctx.value.value * 0.5) : ctx.value.value;
}

/** Recent serious mistake, repeated failure, or a detected misconception (spec §19-20, §22). */
export function scoreRemediation(ctx: CandidateContext): number {
  // A confirmed misconception is a specific, high-confidence signal about
  // this concept — it wins even over an active prerequisite block, unlike
  // the more generic failure/mistake-pressure signals below.
  if (ctx.hasSevereMisconception) return 1;

  const failure = repeatedFailureScore(ctx.attempts);
  const mistakePressure = ctx.value.mistakeScore;
  const raw = Math.max(failure, mistakePressure * 0.8);
  // When blocked, fixing the prerequisite first is the higher-leverage move (spec §9) — same halving scoreActiveRecall applies.
  return clamp01(ctx.value.block.blocked ? raw * 0.5 : raw);
}

/** Target is blocked by a weak prerequisite (spec §19, §9) — 0 when not blocked. */
export function scorePrerequisiteReview(ctx: CandidateContext): number {
  if (!ctx.value.block.blocked) return 0;
  const targetWeakness = ctx.value.weakness;
  const prerequisiteWeakness = ctx.value.block.blockingMastery != null ? clamp01(1 - ctx.value.block.blockingMastery) : 0;
  // A flat bonus keeps this reliably ahead of plain remediation/active-recall on the same target when a block is active (spec §18's worked example ranks it highest).
  return clamp01(0.45 * targetWeakness + 0.4 * prerequisiteWeakness + 0.15);
}

/**
 * Reasonable mastery, but either forgetting risk is climbing (spec §19) or
 * a Phase 9 ReviewItem has actually come due — the stronger of the two
 * signals wins, so a concrete due-for-review schedule never scores lower
 * than the coarser mastery-decay heuristic already did. 0 while still weak
 * (that's Active Recall's job) or blocked.
 */
export function scoreReview(ctx: CandidateContext): number {
  const mastery = 1 - ctx.value.weakness;
  if (mastery < REVIEW_MASTERY_FLOOR || ctx.value.block.blocked) return 0;
  return clamp01(Math.max(ctx.value.forgettingRisk, ctx.reviewUrgency));
}

/**
 * High mastery AND strong recent performance AND healthy prerequisites
 * (spec §19, §21) — recent severe misconceptions override this even at
 * high mastery (spec §22). "Recent performance is strong" is a real gate,
 * not just a bonus: stale mastery with zero recent evidence must not win
 * CHALLENGE over a concept with an actual, current weakness signal — a
 * success streak of at least 1 is required before mastery counts at all.
 */
export function scoreChallenge(ctx: CandidateContext): number {
  const mastery = 1 - ctx.value.weakness;
  if (mastery < CHALLENGE_MASTERY_THRESHOLD || ctx.value.block.blocked || ctx.hasSevereMisconception) return 0;

  const streak = successStreak(ctx.attempts);
  if (streak === 0) return 0;

  const streakFactor = clamp01(streak / CHALLENGE_SUCCESS_STREAK_THRESHOLD);
  return clamp01(mastery * 0.6 + streakFactor * 0.4);
}
