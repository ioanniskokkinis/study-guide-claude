/** Phase 10 dashboard constants — centralized, not scattered inline (matches the convention every prior phase's config.ts follows). */

/** How far back study-streak calculation looks for consecutive active days. */
export const STUDY_STREAK_LOOKBACK_DAYS = 60;

/** Default available study time (minutes) a "today's plan" is built for when the caller doesn't specify one. */
export const DEFAULT_PLAN_MINUTES = 45;
/** Never plan more than this many distinct activities in one day, regardless of available time. */
export const MAX_PLAN_ITEMS = 5;
/** Minutes reserved per due review batch in the plan (capped — reviews are quick per-item, not a big block). */
export const REVIEW_PLAN_MINUTES_PER_ITEM = 2;
export const REVIEW_PLAN_MAX_MINUTES = 15;

/** An EXAM-type learning goal with a target date within this many days triggers an "exam is coming up" notification. */
export const UPCOMING_EXAM_NOTIFICATION_WITHIN_DAYS = 7;
