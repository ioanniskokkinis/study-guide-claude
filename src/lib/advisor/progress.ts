import { prisma } from "@/lib/db/prisma";
import { clamp01 } from "@/lib/learning/mastery-engine";

/**
 * Roadmap progress (Phase 15 §35) — deliberately not just completed/total
 * items. `overallProgressPercent` is a new, phase-15-specific blend (not
 * reused from anywhere else, since nothing in this codebase already
 * measures "progress toward a study plan"): mastery movement is the
 * dominant signal because it's the only one that reflects real learning
 * rather than roadmap bookkeeping, item completion is a secondary signal
 * (a student can complete an item without the underlying mastery moving
 * much yet), and milestone completion is a light tie-breaker. Weights are
 * intentionally simple and documented here, exactly like
 * concept-scoring.ts's own VALUE_WEIGHTS.
 */
const PROGRESS_WEIGHTS = { mastery: 0.5, itemCompletion: 0.3, milestones: 0.2 } as const;

export interface RoadmapProgress {
  totalItems: number;
  completedItems: number;
  overdueItems: number;
  itemCompletionRate: number;
  totalMilestones: number;
  completedMilestones: number;
  /** Live current average mastery across the roadmap's own concepts — refreshed every call, not a snapshot. */
  currentAverageMasteryPercent: number;
  /** Average (current mastery - mastery at roadmap generation time) across items with a concept — the real "has studying this roadmap helped" signal. */
  averageMasteryDelta: number;
  overallProgressPercent: number;
}

/** Returns null if the roadmap doesn't exist or isn't owned by `userId`. */
export async function getRoadmapProgress(userId: string, roadmapId: string): Promise<RoadmapProgress | null> {
  const roadmap = await prisma.studyRoadmap.findFirst({ where: { id: roadmapId, userId }, include: { items: true } });
  if (!roadmap) return null;

  const now = new Date();
  const items = roadmap.items.filter((i) => !i.isMilestone);
  const milestones = roadmap.items.filter((i) => i.isMilestone);

  const totalItems = items.length;
  const completedItems = items.filter((i) => i.status === "COMPLETED").length;
  // Phase 16 §32 — a paused roadmap never accrues overdue penalties; resuming re-evaluates from a clean slate.
  const overdueItems =
    roadmap.status === "PAUSED" ? 0 : items.filter((i) => i.status === "PENDING" && i.scheduledDate != null && i.scheduledDate < now).length;
  const itemCompletionRate = totalItems > 0 ? completedItems / totalItems : 0;

  const totalMilestones = milestones.length;
  const completedMilestones = milestones.filter((i) => i.status === "COMPLETED").length;
  const milestoneRate = totalMilestones > 0 ? completedMilestones / totalMilestones : 0;

  const conceptIds = Array.from(new Set(items.map((i) => i.conceptId).filter((id): id is string => id != null)));
  const masteries = conceptIds.length > 0 ? await prisma.studentConceptMastery.findMany({ where: { userId, conceptId: { in: conceptIds } } }) : [];
  const masteryByConceptId = new Map(masteries.map((m) => [m.conceptId, m.overallMastery]));

  const currentMasteryValues = conceptIds.map((id) => masteryByConceptId.get(id) ?? 0);
  const currentAverageMasteryPercent =
    currentMasteryValues.length > 0 ? currentMasteryValues.reduce((sum, v) => sum + v, 0) / currentMasteryValues.length : 0;

  const deltas = items
    .filter((i) => i.conceptId != null && i.baselineMastery != null)
    .map((i) => (masteryByConceptId.get(i.conceptId as string) ?? (i.baselineMastery as number)) - (i.baselineMastery as number));
  const averageMasteryDelta = deltas.length > 0 ? deltas.reduce((sum, v) => sum + v, 0) / deltas.length : 0;

  const overallProgressPercent = clamp01(
    currentAverageMasteryPercent * PROGRESS_WEIGHTS.mastery +
      itemCompletionRate * PROGRESS_WEIGHTS.itemCompletion +
      milestoneRate * PROGRESS_WEIGHTS.milestones,
  );

  return {
    totalItems,
    completedItems,
    overdueItems,
    itemCompletionRate,
    totalMilestones,
    completedMilestones,
    currentAverageMasteryPercent,
    averageMasteryDelta,
    overallProgressPercent,
  };
}

/** Returns false if the item doesn't exist or its roadmap isn't owned by `userId`. */
export async function updateRoadmapItemStatus(
  userId: string,
  itemId: string,
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED",
): Promise<boolean> {
  const result = await prisma.studyRoadmapItem.updateMany({
    where: { id: itemId, roadmap: { userId } },
    data: { status, completedAt: status === "COMPLETED" ? new Date() : null },
  });
  return result.count > 0;
}
