import { prisma } from "@/lib/db/prisma";
import { STUDY_STREAK_LOOKBACK_DAYS } from "./config";

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Consecutive days (most recent backwards) on which the student had at
 * least one learning interaction in this course — Active Recall, Tutor,
 * exam, or review, since all of them create a LearningAttempt row via
 * recordLearningOutcome(). Same day-bucketing shape as Phase 9's
 * getReviewStreak, generalized across every activity type rather than just
 * reviews (spec §10.10/§10.18's "study streak," distinct from the
 * review-specific streak already shown on the review page).
 */
export async function getStudyStreak(userId: string, courseId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - STUDY_STREAK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const attempts = await prisma.learningAttempt.findMany({
    where: { userId, concept: { courseId }, createdAt: { gte: since } },
    select: { createdAt: true },
  });
  if (attempts.length === 0) return 0;

  const activeDays = new Set(attempts.map((a) => dayKey(a.createdAt)));
  const cursor = new Date(now);
  if (!activeDays.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (activeDays.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
