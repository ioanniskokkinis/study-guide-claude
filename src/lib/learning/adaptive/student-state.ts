import { prisma } from "@/lib/db/prisma";
import type { MistakeSeverity, StudentMistakeCategory } from "@/generated/prisma/client";
import { getCourseMastery, type ConceptMasterySummary } from "@/lib/services/student-knowledge";

/**
 * Everything the adaptive engine needs about a student's course, loaded via
 * a small, fixed number of targeted queries (spec §39 — never "SELECT
 * everything"). This is constructed fresh on every getNextLearningAction()
 * call and never persisted itself (spec §38 — only the resulting decision
 * gets logged, not this snapshot).
 */

export interface ConceptNode {
  id: string;
  name: string;
  difficulty: number;
}

export interface RecentAttemptInfo {
  id: string;
  conceptId: string;
  score: number | null;
  correctness: number | null;
  difficulty: number;
  createdAt: Date;
}

export interface RecentMistakeInfo {
  id: string;
  conceptId: string;
  category: StudentMistakeCategory;
  severity: MistakeSeverity;
  createdAt: Date;
}

export interface LearningGoalInfo {
  id: string;
  type: "EXAM" | "MASTER_COURSE" | "CERTIFICATION" | "GENERAL";
  targetDate: Date | null;
  targetConceptIds: string[] | null;
}

export interface ReviewDueInfo {
  due: boolean;
  overdueDays: number;
  status: string;
}

export interface StudentLearningState {
  userId: string;
  courseId: string;
  concepts: ConceptNode[];
  masteryByConceptId: Map<string, ConceptMasterySummary>;
  /** Most-recent-first, capped; grouped per concept for windowed scoring (repeated failure, success streak, forgetting risk). */
  recentAttemptsByConceptId: Map<string, RecentAttemptInfo[]>;
  /** Most-recent-first, capped; grouped per concept for recency-weighted mistake scoring. */
  recentMistakesByConceptId: Map<string, RecentMistakeInfo[]>;
  /** targetConceptId -> [prerequisiteConceptIds], direct edges only — recursion happens in concept-scoring.ts. */
  prerequisitesByTarget: Map<string, string[]>;
  goals: LearningGoalInfo[];
  lastActivityAt: Date | null;
  /** Concept ids ordered most-recently-practiced-first, deduplicated — drives the recency/interleaving penalty. */
  recentlyPracticedConceptIds: string[];
  /**
   * Phase 9's spaced-repetition due-state per concept, keyed by conceptId.
   * Optional so state built without it (existing tests/fixtures) still
   * type-checks and behaves exactly as before — see
   * calculateReviewUrgencyScore()'s "no data -> 0" default (spec §8: this
   * feeds the *existing* REVIEW action scoring, it does not add a second,
   * competing priority system).
   */
  reviewByConceptId?: Map<string, ReviewDueInfo>;
}

const GLOBAL_RECENT_ATTEMPTS_LIMIT = 100;
const GLOBAL_RECENT_MISTAKES_LIMIT = 100;

export async function getStudentLearningState(userId: string, courseId: string): Promise<StudentLearningState | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true } });
  if (!course) return null;

  const now = new Date();
  const [concepts, courseMastery, prerequisiteEdges, recentAttempts, recentMistakes, goals, reviewItems] = await Promise.all([
    prisma.concept.findMany({ where: { courseId }, select: { id: true, name: true, difficulty: true } }),
    getCourseMastery(userId, courseId),
    prisma.conceptRelationship.findMany({
      where: { relationshipType: "prerequisite", sourceConcept: { courseId } },
      select: { sourceConceptId: true, targetConceptId: true },
    }),
    prisma.learningAttempt.findMany({
      where: { userId, concept: { courseId } },
      orderBy: { createdAt: "desc" },
      take: GLOBAL_RECENT_ATTEMPTS_LIMIT,
      select: { id: true, conceptId: true, score: true, correctness: true, difficulty: true, createdAt: true },
    }),
    prisma.studentMistake.findMany({
      where: { userId, concept: { courseId } },
      orderBy: { createdAt: "desc" },
      take: GLOBAL_RECENT_MISTAKES_LIMIT,
      select: { id: true, conceptId: true, category: true, severity: true, createdAt: true },
    }),
    prisma.learningGoal.findMany({ where: { userId, courseId } }),
    prisma.reviewItem.findMany({
      where: { userId, courseId },
      select: { conceptId: true, nextReviewAt: true, status: true },
    }),
  ]);

  const masteryByConceptId = new Map((courseMastery?.concepts ?? []).map((c) => [c.conceptId, c]));

  const prerequisitesByTarget = new Map<string, string[]>();
  for (const edge of prerequisiteEdges) {
    const list = prerequisitesByTarget.get(edge.targetConceptId) ?? [];
    list.push(edge.sourceConceptId);
    prerequisitesByTarget.set(edge.targetConceptId, list);
  }

  const recentAttemptsByConceptId = new Map<string, RecentAttemptInfo[]>();
  for (const attempt of recentAttempts) {
    const list = recentAttemptsByConceptId.get(attempt.conceptId) ?? [];
    list.push(attempt);
    recentAttemptsByConceptId.set(attempt.conceptId, list);
  }

  const recentMistakesByConceptId = new Map<string, RecentMistakeInfo[]>();
  for (const mistake of recentMistakes) {
    const list = recentMistakesByConceptId.get(mistake.conceptId) ?? [];
    list.push(mistake);
    recentMistakesByConceptId.set(mistake.conceptId, list);
  }

  const recentlyPracticedConceptIds: string[] = [];
  for (const attempt of recentAttempts) {
    if (!recentlyPracticedConceptIds.includes(attempt.conceptId)) {
      recentlyPracticedConceptIds.push(attempt.conceptId);
    }
  }

  const reviewByConceptId = new Map<string, ReviewDueInfo>();
  for (const item of reviewItems) {
    const due = item.nextReviewAt.getTime() <= now.getTime();
    const overdueDays = due ? (now.getTime() - item.nextReviewAt.getTime()) / (1000 * 60 * 60 * 24) : 0;
    reviewByConceptId.set(item.conceptId, { due, overdueDays, status: item.status });
  }

  return {
    userId,
    courseId,
    concepts,
    masteryByConceptId,
    recentAttemptsByConceptId,
    recentMistakesByConceptId,
    prerequisitesByTarget,
    goals: goals.map((g) => ({
      id: g.id,
      type: g.type,
      targetDate: g.targetDate,
      targetConceptIds: Array.isArray(g.targetConceptIds) ? (g.targetConceptIds as string[]) : null,
    })),
    lastActivityAt: recentAttempts[0]?.createdAt ?? null,
    recentlyPracticedConceptIds,
    reviewByConceptId,
  };
}
