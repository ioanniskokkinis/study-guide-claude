/**
 * Phase 16 (Adaptive Study Advisor) tuning constants — every threshold used
 * by trend detection, significant-change detection, roadmap health, and
 * urgency scoring lives here, named and documented, rather than as magic
 * numbers scattered across the adaptation modules. Mirrors the convention
 * already established by src/lib/learning/adaptive/config.ts and
 * src/lib/review/config.ts.
 */

// ---------------------------------------------------------------------------
// Performance trend (spec §5-6)
// ---------------------------------------------------------------------------

/** Fewer than this many recent evidence scores for a concept and the trend is INSUFFICIENT_DATA — avoids overreacting to a single question (spec §5). */
export const TREND_MIN_OBSERVATIONS = 4;
/** How many of the most recent observations count as "recent" vs "prior" when splitting the window for a trend comparison. */
export const TREND_RECENT_WINDOW_SIZE = 3;
/** Minimum swing between the recent-window average and the prior-window average (both 0-1) to call it IMPROVING/DECLINING rather than STABLE. */
export const TREND_SIGNIFICANT_DELTA = 0.15;

// ---------------------------------------------------------------------------
// Significant-change detection (spec §21)
// ---------------------------------------------------------------------------

/** At least this many new KnowledgeEvidence rows (for the roadmap's scoped concepts) since the roadmap was last evaluated before a re-check is even worth running. */
export const SIGNIFICANT_NEW_EVIDENCE_COUNT = 5;
/** A single scoped concept's mastery moving by at least this much since the roadmap's items were generated counts as a meaningful knowledge change. */
export const SIGNIFICANT_MASTERY_SWING = 0.15;
/** This many or more overdue (missed) PENDING items is treated as a meaningful scheduling disruption worth surfacing. */
export const SIGNIFICANT_MISSED_ITEMS = 2;

// ---------------------------------------------------------------------------
// Roadmap health (spec §40) — compares actual progress to the progress
// "expected" from how much of the roadmap's total time window has elapsed.
// ---------------------------------------------------------------------------

/** Actual progress at or above (expected − this margin) reads as ON_TRACK. */
export const HEALTH_AT_RISK_MARGIN = 0.1;
/** Actual progress below (expected − this margin) reads as BEHIND; between the two margins reads as AT_RISK. */
export const HEALTH_BEHIND_MARGIN = 0.25;
/** Before this fraction of the roadmap's time window has elapsed, or with no items at all, health is INSUFFICIENT_DATA rather than a potentially misleading verdict from too little evidence. */
export const HEALTH_MIN_ELAPSED_RATIO = 0.05;

// ---------------------------------------------------------------------------
// Deadline urgency (spec §10) — days-remaining bands, closer mirrors
// adaptive/config.ts's EXAM_URGENCY_BANDS shape but is Advisor-specific
// (the Advisor's own `deadline` field, not LearningGoal.targetDate).
// ---------------------------------------------------------------------------

export const URGENCY_BANDS = {
  criticalWithinDays: 3,
  highWithinDays: 7,
  elevatedWithinDays: 14,
} as const;

export const URGENCY_SCORES = {
  critical: 1.0,
  high: 0.75,
  elevated: 0.5,
  normal: 0.25,
} as const;

// ---------------------------------------------------------------------------
// Exam mode (spec §34) — how close to the deadline before activity shifts
// toward practice/exam simulation.
// ---------------------------------------------------------------------------

export const EXAM_MODE_APPROACHING_WITHIN_DAYS = 14;
export const EXAM_MODE_IMMINENT_WITHIN_DAYS = 3;

// ---------------------------------------------------------------------------
// Capacity / buffer (spec §39)
// ---------------------------------------------------------------------------

/** Fraction of total available minutes reserved as buffer rather than pre-allocated to specific items — absorbs missed work and difficult topics without silently exceeding capacity elsewhere. */
export const BUFFER_RATIO = 0.1;
