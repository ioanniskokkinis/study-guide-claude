import { calculateConceptScores, generateCandidateActions, getStudentState, type ActionType } from "@/lib/learning/adaptive-engine";
import { ESTIMATED_DURATION_MINUTES } from "@/lib/learning/adaptive/config";
import { clamp01 } from "@/lib/learning/mastery-engine";
import { getReviewState } from "@/lib/review/review-queries";
import { DEFAULT_PLAN_MINUTES, MAX_PLAN_ITEMS, REVIEW_PLAN_MAX_MINUTES, REVIEW_PLAN_MINUTES_PER_ITEM } from "./config";

/**
 * "Today's plan" (spec §10.7) — a ranked, time-boxed list of what to do
 * next, built entirely by composing pieces the adaptive engine (Phase 6)
 * and review scheduler (Phase 9) already export. No new scoring logic: the
 * per-concept priorities are the adaptive engine's own
 * generateCandidateActions() output, and the review item's priority is
 * derived from the canonical due/overdue counts (getReviewState) — this
 * file only ranks, dedupes, and time-boxes what already exists.
 */

export interface StudyPlanItem {
  kind: "REVIEW" | "CONCEPT";
  actionType?: ActionType;
  conceptId?: string;
  label: string;
  estimatedMinutes: number;
  reason: string;
  /** Internal ranking signal (0-1) — not necessarily meaningful to show verbatim in the UI, just what determines list order and the time-budget cutoff. */
  priority: number;
}

/** A due review batch's priority grows with how overdue it is — proportionate to, not competing with, the adaptive engine's own review-urgency scoring (same overdueCount it already reads). */
function reviewItemPriority(overdueCount: number): number {
  return clamp01(0.4 + overdueCount * 0.15);
}

export async function getTodaysStudyPlan(
  userId: string,
  courseId: string,
  availableMinutes: number = DEFAULT_PLAN_MINUTES,
): Promise<StudyPlanItem[]> {
  const [state, reviewState] = await Promise.all([getStudentState(userId, courseId), getReviewState(userId, courseId)]);

  const candidateItems: StudyPlanItem[] = [];

  if (reviewState && reviewState.dueCount > 0) {
    const minutes = Math.min(REVIEW_PLAN_MAX_MINUTES, reviewState.dueCount * REVIEW_PLAN_MINUTES_PER_ITEM);
    candidateItems.push({
      kind: "REVIEW",
      label: "Reviews",
      estimatedMinutes: minutes,
      reason: `${reviewState.dueCount} concept${reviewState.dueCount === 1 ? "" : "s"} due for review${
        reviewState.overdueCount > 0 ? ` (${reviewState.overdueCount} overdue)` : ""
      }.`,
      priority: reviewItemPriority(reviewState.overdueCount),
    });
  }

  if (state && state.concepts.length > 0) {
    const scores = calculateConceptScores(state);
    const candidates = generateCandidateActions(state, scores).filter((c) => c.actionType !== "REST");

    // One entry per concept — its highest-priority candidate action — so the same
    // concept never appears twice under two different action types in the same plan.
    const bestByConceptId = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      const existing = bestByConceptId.get(candidate.conceptId);
      if (!existing || candidate.priority > existing.priority) bestByConceptId.set(candidate.conceptId, candidate);
    }

    for (const candidate of bestByConceptId.values()) {
      const concept = state.concepts.find((c) => c.id === candidate.conceptId);
      candidateItems.push({
        kind: "CONCEPT",
        actionType: candidate.actionType,
        conceptId: candidate.conceptId,
        label: concept?.name ?? "Concept",
        estimatedMinutes: ESTIMATED_DURATION_MINUTES[candidate.actionType] ?? 5,
        reason: candidate.reason.message,
        priority: candidate.priority,
      });
    }
  }

  candidateItems.sort((a, b) => b.priority - a.priority);

  const plan: StudyPlanItem[] = [];
  let minutesUsed = 0;
  for (const item of candidateItems) {
    if (plan.length >= MAX_PLAN_ITEMS) break;
    // Always include at least the single highest-priority item, even if it alone exceeds the
    // budget — never return an empty plan just because the most urgent thing takes a while.
    if (plan.length > 0 && minutesUsed + item.estimatedMinutes > availableMinutes) break;
    plan.push(item);
    minutesUsed += item.estimatedMinutes;
  }
  return plan;
}
