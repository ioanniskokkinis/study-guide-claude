import { prisma } from "@/lib/db/prisma";
import { bucketForStatus, getCourseMastery, type ConceptMasterySummary } from "@/lib/services/student-knowledge";
import { getReviewState } from "@/lib/review/review-queries";
import { getStudyStreak } from "./streak";
import { buildWeeklyMasteryTrend, type WeeklyMasteryPoint } from "./sparkline";

const MASTERY_TREND_WEEKS = 8;
const RECENT_EXAM_LIMIT = 10;

export interface ExamScoreSummary {
  examId: string;
  mode: string;
  percentage: number;
  passed: boolean;
  gradedAt: Date;
}

export interface ReviewOutcomeTally {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface CourseAnalytics {
  overallMastery: number;
  /** Weighted (successCount/attemptCount) across every practiced concept — null if nothing has been attempted yet. */
  accuracy: number | null;
  questionsAnswered: number;
  studyTimeMinutes: number;
  studyStreak: number;
  conceptsMastered: number;
  weakConcepts: number;
  reviewsCompleted: number;
  reviewsDue: number;
  examScores: ExamScoreSummary[];
  masteryTrend: WeeklyMasteryPoint[];
  reviewOutcomeTally: ReviewOutcomeTally;
  conceptMastery: ConceptMasterySummary[];
}

/**
 * The read-only aggregate behind the Learning Analytics / Progress page
 * (spec §10.10). Every number here comes from a table Phases 4-9 already
 * populate (StudentConceptMastery, LearningAttempt, KnowledgeEvidence,
 * ReviewEvent, ExamResult) — no new domain model, no AI call, just
 * composition and simple math over data that already exists.
 * Returns null if the course doesn't exist or isn't owned by `userId`.
 */
export async function getCourseAnalytics(userId: string, courseId: string, now: Date = new Date()): Promise<CourseAnalytics | null> {
  const mastery = await getCourseMastery(userId, courseId);
  if (!mastery) return null;

  const [attemptStats, reviewState, streak, reviewEvents, examResults, evidence] = await Promise.all([
    prisma.learningAttempt.aggregate({
      where: { userId, concept: { courseId } },
      _count: { _all: true },
      _sum: { durationSeconds: true },
    }),
    getReviewState(userId, courseId, now),
    getStudyStreak(userId, courseId, now),
    prisma.reviewEvent.groupBy({
      by: ["outcome"],
      where: { userId, concept: { courseId } },
      _count: { _all: true },
    }),
    prisma.examResult.findMany({
      where: { exam: { userId, courseId } },
      orderBy: { gradedAt: "desc" },
      take: RECENT_EXAM_LIMIT,
      select: { examId: true, percentage: true, passed: true, gradedAt: true, exam: { select: { mode: true } } },
    }),
    prisma.knowledgeEvidence.findMany({
      where: { userId, concept: { courseId } },
      select: { score: true, createdAt: true },
    }),
  ]);

  const practiced = mastery.concepts.filter((c) => c.exposureCount > 0);
  const totalAttempts = practiced.reduce((sum, c) => sum + c.attemptCount, 0);
  const totalSuccesses = practiced.reduce((sum, c) => sum + c.successCount, 0);
  const accuracy = totalAttempts > 0 ? totalSuccesses / totalAttempts : null;

  const reviewTally: ReviewOutcomeTally = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const group of reviewEvents) {
    if (group.outcome === "AGAIN") reviewTally.again = group._count._all;
    else if (group.outcome === "HARD") reviewTally.hard = group._count._all;
    else if (group.outcome === "GOOD") reviewTally.good = group._count._all;
    else if (group.outcome === "EASY") reviewTally.easy = group._count._all;
  }

  return {
    overallMastery: mastery.overallMastery,
    accuracy,
    questionsAnswered: attemptStats._count._all,
    studyTimeMinutes: Math.round((attemptStats._sum.durationSeconds ?? 0) / 60),
    studyStreak: streak,
    conceptsMastered: mastery.concepts.filter((c) => c.status === "MASTERED").length,
    weakConcepts: practiced.filter((c) => bucketForStatus(c.status) === "weak").length,
    reviewsCompleted: reviewTally.again + reviewTally.hard + reviewTally.good + reviewTally.easy,
    reviewsDue: reviewState?.dueCount ?? 0,
    examScores: examResults.map((r) => ({
      examId: r.examId,
      mode: r.exam.mode,
      percentage: r.percentage,
      passed: r.passed,
      gradedAt: r.gradedAt,
    })),
    masteryTrend: buildWeeklyMasteryTrend(evidence, MASTERY_TREND_WEEKS, now),
    reviewOutcomeTally: reviewTally,
    conceptMastery: mastery.concepts.slice().sort((a, b) => b.overallMastery - a.overallMastery),
  };
}
