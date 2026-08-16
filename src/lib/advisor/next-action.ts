import { prisma } from "@/lib/db/prisma";
import type { StudyRoadmapItemAction } from "@/generated/prisma/client";
import { getTodayPlan } from "./queries";
import { getDueReviews } from "@/lib/review/review-queries";
import { analyzeKnowledgeGaps, NoScopedConceptsError } from "./knowledge-gaps";
import { actionForPriority } from "./roadmap-service";
import { buildItemReason } from "./reasons";
import { applyExamModeBias, examModePhase } from "./exam-mode";
import { MASTERY_THRESHOLDS } from "@/lib/learning/mastery-engine";

/**
 * Deterministic "what should I study now?" (Phase 16 §18-19) — no AI call,
 * ever. Reuses, in priority order: the roadmap's own already-scheduled
 * today/overdue items (Phase 15's `getTodayPlan`), the existing spaced-
 * repetition due-queue (`getDueReviews`, Phase 9's own canonical due
 * query — never a second one), and Phase 6's knowledge-gap ranking as a
 * final fallback. A very-low-accuracy, repeatedly-missed concept is
 * redirected to TUTOR (spec §16) rather than more unsupervised practice.
 */
export type NextBestActionType =
  | "REVIEW_TOPIC"
  | "PRACTICE_TOPIC"
  | "LEARN_PREREQUISITE"
  | "ACTIVE_RECALL"
  | "TUTOR"
  | "EXAM_PRACTICE"
  | "SPACED_REPETITION";

export interface NextBestAction {
  type: NextBestActionType;
  conceptId: string;
  conceptName: string;
  durationMinutes: number;
  reason: string;
  /** Set when this recommendation corresponds to an already-scheduled roadmap item, so the UI can mark it complete directly. */
  roadmapItemId: string | null;
}

export type NextBestActionResult = NextBestAction | { type: "NONE"; reason: string };

const ACTION_MAP: Record<StudyRoadmapItemAction, NextBestActionType> = {
  LEARN: "LEARN_PREREQUISITE",
  REVIEW: "REVIEW_TOPIC",
  PRACTICE: "PRACTICE_TOPIC",
  ACTIVE_RECALL: "ACTIVE_RECALL",
  SPACED_REPETITION: "SPACED_REPETITION",
  TUTOR: "TUTOR",
  EXAM_PRACTICE: "EXAM_PRACTICE",
};

const DEFAULT_REVIEW_MINUTES = 15;
/** Below this overall priority `value`, a concept isn't worth actively recommending — it reads as "essentially caught up," not a real gap. */
const MEANINGFUL_VALUE_THRESHOLD = 0.05;

interface TutorSignal {
  recommend: boolean;
  recentAccuracyPercent: number | null;
}

/** Recent-accuracy + incorrect-streak check driving the Tutor recommendation (spec §16's own example: "recent accuracy 35%, 4 repeated incorrect answers"). */
async function checkTutorSignal(userId: string, conceptId: string): Promise<TutorSignal> {
  const recent = await prisma.learningAttempt.findMany({
    where: { userId, conceptId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { correctness: true, score: true },
  });
  if (recent.length < 3) return { recommend: false, recentAccuracyPercent: null };

  const scored = recent.map((a) => a.correctness ?? a.score).filter((v): v is number => v != null);
  const average = scored.length > 0 ? scored.reduce((sum, v) => sum + v, 0) / scored.length : null;

  let incorrectStreak = 0;
  for (const attempt of recent) {
    const value = attempt.correctness ?? attempt.score;
    if (value != null && value < 0.5) incorrectStreak++;
    else break;
  }

  return { recommend: average != null && average < 0.4 && incorrectStreak >= 3, recentAccuracyPercent: average };
}

export async function getNextBestAction(userId: string, roadmapId: string, now: Date = new Date()): Promise<NextBestActionResult | null> {
  const roadmap = await prisma.studyRoadmap.findFirst({ where: { id: roadmapId, userId } });
  if (!roadmap) return null;

  if (roadmap.status !== "ACTIVE") {
    return { type: "NONE", reason: "This roadmap isn't active right now." };
  }

  const today = await getTodayPlan(userId, roadmapId);
  const pending = [...(today?.overdue ?? []), ...(today?.today ?? [])]
    .filter((item) => item.status === "PENDING" || item.status === "IN_PROGRESS")
    .sort((a, b) => b.priority - a.priority);

  if (pending.length > 0 && pending[0].conceptId) {
    const top = pending[0];
    const concept = await prisma.concept.findUnique({ where: { id: top.conceptId! }, select: { name: true } });
    const tutorSignal = await checkTutorSignal(userId, top.conceptId!);

    if (tutorSignal.recommend) {
      return {
        type: "TUTOR",
        conceptId: top.conceptId!,
        conceptName: concept?.name ?? top.title,
        durationMinutes: top.estimatedMinutes,
        reason: `Your recent accuracy on this is ${Math.round((tutorSignal.recentAccuracyPercent ?? 0) * 100)}%. A Tutor session can help before more practice.`,
        roadmapItemId: top.id,
      };
    }

    return {
      type: ACTION_MAP[top.action],
      conceptId: top.conceptId!,
      conceptName: concept?.name ?? top.title,
      durationMinutes: top.estimatedMinutes,
      reason: top.reason,
      roadmapItemId: top.id,
    };
  }

  const scopedConceptIds = Array.from(
    new Set(
      (
        await prisma.studyRoadmapItem.findMany({ where: { roadmapId, isMilestone: false, conceptId: { not: null } }, select: { conceptId: true } })
      )
        .map((i) => i.conceptId)
        .filter((id): id is string => id !== null),
    ),
  );

  const dueReviews = await getDueReviews(userId, roadmap.courseId, now);
  const dueInScope = dueReviews.filter((r) => scopedConceptIds.includes(r.conceptId));
  if (dueInScope.length > 0) {
    const mostOverdue = dueInScope[0];
    return {
      type: "SPACED_REPETITION",
      conceptId: mostOverdue.conceptId,
      conceptName: mostOverdue.conceptName,
      durationMinutes: DEFAULT_REVIEW_MINUTES,
      reason:
        mostOverdue.overdueDays >= 1
          ? `This is due for review — ${Math.floor(mostOverdue.overdueDays)} day${Math.floor(mostOverdue.overdueDays) === 1 ? "" : "s"} overdue.`
          : "This is due for review today.",
      roadmapItemId: null,
    };
  }

  try {
    const gaps = await analyzeKnowledgeGaps(userId, roadmap.courseId, scopedConceptIds);
    const top = gaps.priorities[0];
    if (!top || top.breakdown.value < MEANINGFUL_VALUE_THRESHOLD) {
      return { type: "NONE", reason: "You're caught up — nothing urgent to study right now." };
    }

    const phase = examModePhase(roadmap.deadline, now);
    const baseAction = actionForPriority(top);
    const action = applyExamModeBias(baseAction, phase, top.masteryPercent < MASTERY_THRESHOLDS.weak);

    return {
      type: ACTION_MAP[action],
      conceptId: top.conceptId,
      conceptName: top.conceptName,
      durationMinutes: DEFAULT_REVIEW_MINUTES,
      reason: buildItemReason(top, roadmap.deadline ? Math.max(0, Math.round((roadmap.deadline.getTime() - now.getTime()) / 86_400_000)) : null),
      roadmapItemId: null,
    };
  } catch (error) {
    if (error instanceof NoScopedConceptsError) {
      return { type: "NONE", reason: "We don't have enough learning data yet to recommend a next step." };
    }
    throw error;
  }
}
