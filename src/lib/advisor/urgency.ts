import { prisma } from "@/lib/db/prisma";
import { calculateTimeBudget } from "./time-budget";
import { URGENCY_BANDS, URGENCY_SCORES } from "./config";

/**
 * Deterministic deadline urgency (Phase 16 §9-10) — a days-remaining band
 * (mirroring the shape of adaptive/config.ts's own EXAM_URGENCY_BANDS,
 * documented as its own Advisor-specific constants rather than importing
 * theirs, since this scores the Advisor's own `deadline` field, not
 * Phase 6's LearningGoal.targetDate) plus a hard capacity check: is what's
 * left to do mathematically possible in what's left of the student's stated
 * available time?
 */
export interface UrgencyResult {
  /** 0-1 — how much deadline pressure should influence prioritization. */
  urgencyScore: number;
  daysRemaining: number | null;
  /** True when requiredMinutes exceeds availableMinutes — the goal is not achievable within the stated capacity as currently scheduled (spec §9's "INSUFFICIENT_TIME"). */
  insufficientTime: boolean;
  requiredMinutes: number;
  availableMinutes: number;
}

export function calculateUrgency(params: {
  now: Date;
  deadline: Date | null;
  requiredMinutes: number;
  availableMinutes: number;
}): UrgencyResult {
  const daysRemaining = params.deadline
    ? Math.max(0, (params.deadline.getTime() - params.now.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  let urgencyScore: number;
  if (daysRemaining === null) urgencyScore = URGENCY_SCORES.normal;
  else if (daysRemaining <= URGENCY_BANDS.criticalWithinDays) urgencyScore = URGENCY_SCORES.critical;
  else if (daysRemaining <= URGENCY_BANDS.highWithinDays) urgencyScore = URGENCY_SCORES.high;
  else if (daysRemaining <= URGENCY_BANDS.elevatedWithinDays) urgencyScore = URGENCY_SCORES.elevated;
  else urgencyScore = URGENCY_SCORES.normal;

  const insufficientTime = params.requiredMinutes > params.availableMinutes;

  return { urgencyScore, daysRemaining, insufficientTime, requiredMinutes: params.requiredMinutes, availableMinutes: params.availableMinutes };
}

/**
 * DB-aware wrapper: `requiredMinutes` is the sum of every not-yet-completed,
 * non-milestone item still on the roadmap (what's genuinely left to do);
 * `availableMinutes` is the deterministic time budget (Phase 15's
 * `calculateTimeBudget`) between now and the roadmap's deadline (or its
 * `endDate` if no deadline was set). Returns null if the roadmap doesn't
 * exist or isn't owned by `userId`.
 */
export async function getRoadmapUrgency(userId: string, roadmapId: string, now: Date = new Date()): Promise<UrgencyResult | null> {
  const roadmap = await prisma.studyRoadmap.findFirst({ where: { id: roadmapId, userId } });
  if (!roadmap) return null;

  const remainingItems = await prisma.studyRoadmapItem.findMany({
    where: { roadmapId, isMilestone: false, status: { in: ["PENDING", "IN_PROGRESS"] } },
    select: { estimatedMinutes: true },
  });
  const requiredMinutes = remainingItems.reduce((sum, item) => sum + item.estimatedMinutes, 0);

  const deadline = roadmap.deadline ?? roadmap.endDate;
  const availableMinutes = deadline
    ? calculateTimeBudget({
        minutesPerDay: roadmap.minutesPerDay,
        studyDays: Array.isArray(roadmap.studyDays) ? (roadmap.studyDays as number[]) : [],
        startDate: now,
        endDate: deadline,
      }).totalMinutes
    : requiredMinutes; // no deadline at all — nothing to compare against, so never flag insufficient time.

  return calculateUrgency({ now, deadline: roadmap.deadline, requiredMinutes, availableMinutes });
}
