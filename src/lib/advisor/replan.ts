import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "./roadmap-service";
import type { ScopeInput } from "./scope";

export class RoadmapNotFoundError extends Error {
  constructor() {
    super("Roadmap not found.");
  }
}

export class RoadmapNotActiveError extends Error {
  constructor() {
    super("Only an active roadmap can be replanned.");
  }
}

function reconstructScope(roadmap: {
  scopeType: "COURSE" | "FOLDER" | "DOCUMENTS";
  scopeFolderId: string | null;
  scopeDocuments: Array<{ documentId: string }>;
}): ScopeInput {
  if (roadmap.scopeType === "COURSE") return { scopeType: "COURSE" };
  if (roadmap.scopeType === "FOLDER") return { scopeType: "FOLDER", folderId: roadmap.scopeFolderId };
  return { scopeType: "DOCUMENTS", documentIds: roadmap.scopeDocuments.map((d) => d.documentId) };
}

/**
 * Replans an active roadmap (Phase 15 §36-38) — reuses the exact same
 * course/goal/time-budget-shape/material scope, but re-runs the full
 * deterministic pipeline (knowledge-gap analysis, time budget, AI call)
 * against CURRENT knowledge state. Completed work is never re-explained or
 * special-cased: because calculateConceptValue() already scores by current
 * mastery, a concept the student genuinely improved on naturally drops in
 * priority on its own — the same mechanism that already ranks concepts for
 * a first-time roadmap. Overdue/completed counts are surfaced to the AI
 * honestly (spec §36, §38) rather than silently ignored. The old roadmap is
 * archived, never deleted (createStudyRoadmap sets `replacesRoadmapId` and
 * flips the old row's status inside the same transaction).
 */
export async function replanStudyRoadmap(userId: string, roadmapId: string) {
  const roadmap = await prisma.studyRoadmap.findFirst({
    where: { id: roadmapId, userId },
    include: { items: { where: { isMilestone: false } }, scopeDocuments: true },
  });
  if (!roadmap) throw new RoadmapNotFoundError();
  if (roadmap.status !== "ACTIVE") throw new RoadmapNotActiveError();

  const now = new Date();
  const overdueCount = roadmap.items.filter((i) => i.status === "PENDING" && i.scheduledDate != null && i.scheduledDate < now).length;
  const completedCount = roadmap.items.filter((i) => i.status === "COMPLETED").length;

  const deadline = roadmap.deadline && roadmap.deadline.getTime() > now.getTime() ? roadmap.deadline : null;

  return createStudyRoadmap(userId, {
    courseId: roadmap.courseId,
    goal: roadmap.goal,
    targetScore: roadmap.targetScore,
    deadline,
    minutesPerDay: roadmap.minutesPerDay,
    studyDays: Array.isArray(roadmap.studyDays) ? (roadmap.studyDays as number[]) : [],
    scope: reconstructScope(roadmap),
    replacesRoadmapId: roadmap.id,
    replanContext: { overdueCount, completedCount },
  });
}
