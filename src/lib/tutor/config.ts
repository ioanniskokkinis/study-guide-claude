/**
 * Tunable thresholds for the tutor engine, named and documented rather than
 * inlined magic numbers — same convention as src/lib/learning/adaptive/config.ts.
 */

/** Socratic questioning never goes deeper than this before forcing a transition to explanation/remediation (spec §9-10). */
export const MAX_SOCRATIC_DEPTH = 4;

/** Consecutive incorrect answers on the same concept within a session before REMEDIATE overrides Socratic progression (spec §10, §15). */
export const REPEATED_FAILURE_THRESHOLD = 3;

/** Independent (non-hinted, non-revealed) correct responses required, with no active high-severity misconception, before a session can COMPLETE (spec §49). */
export const COMPLETION_CORRECT_STREAK = 2;

/** Teach-back score bands (spec §21). */
export const TEACH_BACK_BAND_STRONG = 0.85;
export const TEACH_BACK_BAND_FOLLOWUP = 0.6;
export const TEACH_BACK_BAND_REMEDIATION = 0.4;

/** Teach-back score component weights (spec §20) — sum to 1.0. */
export const TEACH_BACK_WEIGHTS = {
  correctness: 0.35,
  completeness: 0.25,
  conceptualAccuracy: 0.25,
  misconceptionPenalty: 0.15,
} as const;

/**
 * Evidence-strength multipliers applied to a correct answer's score before
 * it reaches recordLearningOutcome() (spec §24) — hints make correct
 * evidence weaker, proportional to how much help was given. A REVEAL never
 * reaches this path at all: it produces no evidence of its own (spec §46),
 * only the mandatory retrieval question that follows it does, at full
 * weight, since that's an independent attempt.
 */
export const HINT_EVIDENCE_DISCOUNT: Record<1 | 2 | 3, number> = {
  1: 0.85,
  2: 0.65,
  3: 0.4,
};

/** A student self-reporting CONFIDENT while answering INCORRECT is the illusion-of-competence signal (spec §30). */
export const ILLUSION_OF_COMPETENCE_SEVERITY = "HIGH" as const;

/**
 * A misconception is "resolved" only once independent correct evidence has
 * accumulated since it was last (re-)detected (spec §13) — never on a
 * single correct answer. Confidence decays by a fixed amount per piece of
 * independent evidence; resolution requires both the evidence count and the
 * confidence floor.
 */
export const MISCONCEPTION_RESOLUTION_EVIDENCE_COUNT = 2;
export const MISCONCEPTION_CONFIDENCE_DECAY_PER_EVIDENCE = 0.4;
export const MISCONCEPTION_RESOLVED_CONFIDENCE_FLOOR = 0.25;

/** Initial confidence assigned to a newly detected misconception, by severity. */
export const MISCONCEPTION_INITIAL_CONFIDENCE: Record<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL", number> = {
  LOW: 0.5,
  MEDIUM: 0.7,
  HIGH: 0.9,
  CRITICAL: 1.0,
};

/** How many recent conversation turns are sent to Claude as context (spec §36 — never the whole course). */
export const CONVERSATION_HISTORY_WINDOW = 6;

/** How many recent LearningAttempt scores inform illusion-of-competence / repeated-failure checks. */
export const RECENT_ATTEMPT_WINDOW = 5;
