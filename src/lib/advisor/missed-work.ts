import { prisma } from "@/lib/db/prisma";

/**
 * Deterministic missed-study-session detection (Phase 16 §7) — reads
 * directly off `StudyRoadmapItem.status`/`scheduledDate`, the same fields
 * `getRoadmapProgress`'s `overdueItems` count (Phase 15) already uses; this
 * module just adds the minute/session-level detail recovery planning needs.
 */
export interface MissedWorkSummary {
  /** Sum of estimatedMinutes across overdue (PENDING, scheduledDate in the past) non-milestone items. */
  missedMinutes: number;
  /** Distinct calendar dates with at least one missed item — "3 sessions missed," not "3 items missed." */
  missedSessionsCount: number;
  overdueItemCount: number;
}

/** Returns null if the roadmap doesn't exist or isn't owned by `userId`. */
export async function getMissedWorkSummary(userId: string, roadmapId: string, now: Date = new Date()): Promise<MissedWorkSummary | null> {
  const roadmap = await prisma.studyRoadmap.findFirst({ where: { id: roadmapId, userId } });
  if (!roadmap) return null;
  // Phase 16 §32 — no missed-work accounting while paused.
  if (roadmap.status === "PAUSED") return { missedMinutes: 0, missedSessionsCount: 0, overdueItemCount: 0 };

  const overdueItems = await prisma.studyRoadmapItem.findMany({
    where: { roadmapId, status: "PENDING", isMilestone: false, scheduledDate: { lt: now } },
    select: { estimatedMinutes: true, scheduledDate: true },
  });

  const missedMinutes = overdueItems.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  const missedDates = new Set(overdueItems.map((item) => item.scheduledDate!.toISOString().slice(0, 10)));

  return { missedMinutes, missedSessionsCount: missedDates.size, overdueItemCount: overdueItems.length };
}
