/**
 * All tunable thresholds for the adaptive engine, in one place (spec §10:
 * "Do not make these values hardcoded inside algorithms"). Every scoring
 * function in concept-scoring.ts/action-scoring.ts reads from here rather
 * than embedding a magic number.
 */

/** Below this mastery, a prerequisite is considered "weak" for blocking purposes (spec §10). */
export const PREREQUISITE_MASTERY_THRESHOLD = 0.6;
/** A prerequisite only blocks its target if it's at least this much weaker than the target (spec §10). */
export const PREREQUISITE_GAP_THRESHOLD = 0.2;
/** How many levels of prerequisites to inspect recursively (spec §8). */
export const MAX_PREREQUISITE_DEPTH = 5;

/** A concept mastery below this is still "weak" for weakness scoring purposes; mirrors mastery-engine.ts's MASTERY_THRESHOLDS.weak. */
export const WEAK_MASTERY_THRESHOLD = 0.3;
/** Mastery at/above this, combined with strong recent performance, is eligible for CHALLENGE (spec §19/§21). */
export const CHALLENGE_MASTERY_THRESHOLD = 0.8;
/** Mastery at/above this with no urgent signals is eligible for REVIEW instead of ACTIVE_RECALL (spec §19). */
export const REVIEW_MASTERY_FLOOR = 0.5;

/** Recent-mistake time decay: a mistake this many hours ago retains ~half its weight (spec §11). */
export const MISTAKE_HALF_LIFE_HOURS = 48;
/** Mistakes older than this are considered handled by forgetting/review logic instead (spec §11). */
export const MISTAKE_RELEVANCE_WINDOW_DAYS = 21;
/** Per-severity weight multiplier for a mistake's contribution (spec §12). */
export const MISTAKE_SEVERITY_WEIGHT: Record<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL", number> = {
  LOW: 0.25,
  MEDIUM: 0.5,
  HIGH: 0.85,
  CRITICAL: 1,
};
/** A misconception at/above this severity can override an otherwise-high mastery score (spec §22). */
export const MISCONCEPTION_OVERRIDE_SEVERITY: Array<"HIGH" | "CRITICAL"> = ["HIGH", "CRITICAL"];

/** Forgetting-risk decay: retention half-life at zero mastery, in days — scaled up by mastery (spec §13). */
export const FORGETTING_BASE_HALF_LIFE_DAYS = 7;
/** Extra half-life days granted per point of mastery (0-1) — higher mastery forgets slower. */
export const FORGETTING_MASTERY_HALF_LIFE_BONUS_DAYS = 21;

/** How many of the most recent attempts count toward recency/interleaving penalties (spec §14). */
export const RECENCY_WINDOW_SIZE = 5;
/** Penalty applied to a concept practiced most recently, decaying linearly across the window. */
export const RECENCY_MAX_PENALTY = 0.4;

/** Exam urgency bands, in days-until-target-date (spec §16). */
export const EXAM_URGENCY_BANDS = {
  veryHighWithinDays: 7,
  highWithinDays: 14,
  increasedWithinDays: 30,
} as const;
export const EXAM_URGENCY_SCORES = {
  veryHigh: 1,
  high: 0.7,
  increased: 0.4,
  normal: 0.15,
} as const;

/** Repeated-failure window and threshold (spec §20). */
export const REPEATED_FAILURE_WINDOW_SIZE = 5;
export const REPEATED_FAILURE_STRONG_THRESHOLD = 3;

/** Success streak needed (on top of high mastery) to favor CHALLENGE (spec §21). */
export const CHALLENGE_SUCCESS_STREAK_THRESHOLD = 3;

/** Estimated minutes per action type, shown to the student (spec §2 example). */
export const ESTIMATED_DURATION_MINUTES: Record<string, number> = {
  ACTIVE_RECALL: 5,
  REMEDIATION: 5,
  PREREQUISITE_REVIEW: 5,
  REVIEW: 3,
  CHALLENGE: 7,
  REST: 0,
};
