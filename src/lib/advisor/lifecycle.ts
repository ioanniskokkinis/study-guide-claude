import { prisma } from "@/lib/db/prisma";
import { checkAdaptationNeeded, type AdaptationCheckResult } from "./change-detection";
import { RoadmapNotFoundError } from "./replan";

export { RoadmapNotFoundError };

export class RoadmapNotPausedError extends Error {
  constructor() {
    super("This roadmap isn't paused.");
  }
}

export class RoadmapNotResumableError extends Error {
  constructor() {
    super("Only an active roadmap can be paused.");
  }
}

/**
 * Pauses a roadmap (Phase 16 §32) — while paused, `getRoadmapProgress`'s
 * overdue count and `checkAdaptationNeeded` both skip PAUSED roadmaps
 * entirely, so no overdue penalty or automatic-adaptation prompt accrues.
 * Progress already made is left exactly as it is.
 */
export async function pauseRoadmap(userId: string, roadmapId: string) {
  const roadmap = await prisma.studyRoadmap.findFirst({ where: { id: roadmapId, userId } });
  if (!roadmap) throw new RoadmapNotFoundError();
  if (roadmap.status !== "ACTIVE") throw new RoadmapNotResumableError();

  return prisma.studyRoadmap.update({ where: { id: roadmapId }, data: { status: "PAUSED" } });
}

export interface ResumeResult {
  roadmapId: string;
  status: "ACTIVE";
  /** Deterministic read of whether the plan likely needs adjusting now that time has passed (spec §32's "recalculate current state... offer updated plan") — never auto-applied, just surfaced so the student can choose to replan. */
  suggestedAdaptation: AdaptationCheckResult;
}

/** Resumes a paused roadmap. Never auto-replans — only flips status back to ACTIVE and returns a deterministic signal for whether a replan is worth offering. */
export async function resumeRoadmap(userId: string, roadmapId: string): Promise<ResumeResult> {
  const roadmap = await prisma.studyRoadmap.findFirst({ where: { id: roadmapId, userId } });
  if (!roadmap) throw new RoadmapNotFoundError();
  if (roadmap.status !== "PAUSED") throw new RoadmapNotPausedError();

  const updated = await prisma.studyRoadmap.update({ where: { id: roadmapId }, data: { status: "ACTIVE" } });
  const suggestedAdaptation = await checkAdaptationNeeded(userId, updated.id);

  return { roadmapId: updated.id, status: "ACTIVE", suggestedAdaptation };
}
