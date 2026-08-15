/**
 * Tunable thresholds for the exam engine, named and documented rather than
 * inlined magic numbers — same convention as the adaptive engine's
 * src/lib/learning/adaptive/config.ts and the tutor's src/lib/tutor/config.ts.
 */

// ---------------------------------------------------------------------------
// Blueprint / coverage (spec §5-6, §10-11)
// ---------------------------------------------------------------------------

/**
 * Default diagnostic-coverage ratios by mastery tier (spec §11) —
 * configurable per exam, never hardcoded inline in exam-blueprint.ts. A
 * weak-tier concept gets a bigger share of the exam's question budget than
 * a strong one, but never zero share for strong concepts (spec §10 — "a
 * valid exam must assess broad understanding").
 */
export const DEFAULT_DIAGNOSTIC_RATIOS = {
  strong: 0.15,
  medium: 0.35,
  weak: 0.5,
} as const;

/** No single concept may claim more than this share of the exam's questions (spec §6), unless it's the only concept available. */
export const MAX_SINGLE_CONCEPT_SHARE = 0.4;

/** Every tested concept gets at least one question once selected for coverage. */
export const MIN_QUESTIONS_PER_CONCEPT = 1;

/** Default cognitive-level distribution (spec §36) — sums to 1.0. */
export const DEFAULT_COGNITIVE_DISTRIBUTION: Record<"RECALL" | "UNDERSTAND" | "APPLY" | "ANALYZE" | "EVALUATE", number> = {
  RECALL: 0.2,
  UNDERSTAND: 0.25,
  APPLY: 0.3,
  ANALYZE: 0.25,
  EVALUATE: 0,
};

// ---------------------------------------------------------------------------
// Exam mode defaults
// ---------------------------------------------------------------------------

export const DEFAULT_QUESTION_COUNT = 20;
export const DEFAULT_DURATION_MINUTES = 45;
export const DEFAULT_PASSING_SCORE = 0.75;
export const RETEST_QUESTION_COUNT = 8;

/** Recently-used exam question ids/prompts to avoid immediately repeating (spec §47). */
export const RECENT_EXAM_PROMPTS_TO_AVOID = 8;
export const SOURCE_CHUNKS_PER_EXAM_QUESTION = 5;
export const DUPLICATE_JACCARD_THRESHOLD = 0.85;
export const MAX_GENERATION_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Grading (spec §20-23)
// ---------------------------------------------------------------------------

/** Rubric-criterion weights the backend combines into a deterministic final score (spec §22-23) — Claude only ever returns the per-criterion scores. */
export const RUBRIC_CRITERION_WEIGHTS = {
  correctness: 0.35,
  completeness: 0.2,
  reasoning: 0.2,
  application: 0.15,
  conceptualUnderstanding: 0.1,
} as const;

export const CLASSIFICATION_SCORE_BANDS = {
  correct: 0.85,
  partiallyCorrect: 0.4,
} as const;

/**
 * A hinted correct answer is weaker evidence than an independent one (spec
 * §15, mirrors Phase 7's hint-discount principle) — exams don't have
 * Phase 7's progressive hint *levels*, just a single "hint used" flag per
 * question, so one flat discount is enough here.
 */
export const EXAM_HINT_EVIDENCE_DISCOUNT = 0.7;

// ---------------------------------------------------------------------------
// Mistake severity (spec §25)
// ---------------------------------------------------------------------------

export const MISTAKE_SEVERITY_WEIGHTS = {
  conceptImportance: 0.3,
  frequency: 0.25,
  prerequisiteImpact: 0.25,
  confidenceMismatch: 0.2,
} as const;

// ---------------------------------------------------------------------------
// Readiness (spec §40-41)
// ---------------------------------------------------------------------------

/** Readiness components' weights (spec §40) — sum to 1.0 for interpretability, same discipline as the adaptive engine's concept-value formula. */
export const READINESS_WEIGHTS = {
  mastery: 0.35,
  recentExamPerformance: 0.25,
  consistency: 0.15,
  prerequisiteHealth: 0.15,
  forgettingRisk: 0.1,
} as const;

/** Each active misconception on a targeted concept subtracts this much from readiness, up to a floor. */
export const MISCONCEPTION_READINESS_PENALTY = 0.08;
export const MAX_MISCONCEPTION_PENALTY = 0.3;

export const READINESS_STATUS_THRESHOLDS = {
  notReady: 0.4,
  developing: 0.6,
  almostReady: 0.8,
  ready: 0.95,
} as const;

/** How many past exams inform "recent exam performance" and "consistency" (variance). */
export const RECENT_EXAM_WINDOW = 5;

// ---------------------------------------------------------------------------
// Adaptive exam (spec §12-13)
// ---------------------------------------------------------------------------

export const ADAPTIVE_INCREASE_THRESHOLD = 0.8;
export const ADAPTIVE_DECREASE_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Oral exam (spec §28-31)
// ---------------------------------------------------------------------------

export const ORAL_MAX_DEPTH = 5;
/** Two weak responses in a row end the oral line of questioning on this concept rather than grinding deeper. */
export const ORAL_MAX_CONSECUTIVE_WEAK = 2;
