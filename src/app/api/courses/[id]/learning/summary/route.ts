import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getCourseMastery, bucketForStatus } from "@/lib/services/student-knowledge";
import { getReviewState } from "@/lib/review/review-queries";
import { rankWeakConcepts } from "@/lib/learning/weak-concepts";
import { getNextLearningAction, NoConceptsAvailableError } from "@/lib/learning/adaptive-engine";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const WEAK_CONCEPTS_PREVIEW_LIMIT = 5;

/**
 * The single aggregation the personalized "Your Learning" dashboard section
 * needs (Phase 2 §P): overall mastery + bucket counts, due-review state, a
 * ranked weak-concepts preview, and the deterministic recommended next
 * action — each pulled from its one existing canonical service
 * (student-knowledge.ts, review-queries.ts, weak-concepts.ts,
 * adaptive-engine.ts) rather than recomputed here. No Claude call.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const [mastery, reviewState, weakConcepts] = await Promise.all([
    getCourseMastery(user.id, courseId),
    getReviewState(user.id, courseId),
    rankWeakConcepts(user.id, courseId),
  ]);

  if (!mastery || !reviewState || weakConcepts === null) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  const counts = { strong: 0, developing: 0, weak: 0, unknown: 0 };
  for (const concept of mastery.concepts) {
    counts[bucketForStatus(concept.status)] += 1;
  }

  let recommendedAction = null;
  try {
    recommendedAction = (await getNextLearningAction({ userId: user.id, courseId })).action;
  } catch (error) {
    if (!(error instanceof NoConceptsAvailableError)) {
      console.error("Failed to compute recommended next action for learning summary:", error);
    }
  }

  return NextResponse.json({
    overallMastery: mastery.overallMastery,
    counts,
    dueCount: reviewState.dueCount,
    overdueCount: reviewState.overdueCount,
    reviewStreak: reviewState.reviewStreak,
    weakConcepts: weakConcepts.slice(0, WEAK_CONCEPTS_PREVIEW_LIMIT),
    weakConceptsTotal: weakConcepts.length,
    recommendedAction,
  });
}
