import { prisma } from "@/lib/db/prisma";
import type { AdaptationTrigger } from "@/generated/prisma/client";
import { createStudyRoadmap } from "./roadmap-service";
import { getMissedWorkSummary } from "./missed-work";
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

export interface ReplanOptions {
  /** Why this replan is happening (Phase 16 §3) — defaults to MANUAL_REPLAN, the Phase 15 "Replan" button's original behavior (spec §29 — that action stays exactly as it was). */
  trigger?: AdaptationTrigger;
  /** Shown to the student (Phase 16 §44). A sensible default is generated from `trigger` when omitted. */
  reason?: string;
  /** Overrides the roadmap's stored deadline (Phase 16 §30 — deadline change). Omit to keep the current deadline (or its computed default horizon if none was set). */
  deadline?: Date | null;
  /** Overrides the roadmap's stored minutesPerDay (Phase 16 §31 — capacity change). Never retroactively changes historical study time — only affects the newly-generated future plan. */
  minutesPerDay?: number;
  studyDays?: number[];
}

const DEFAULT_REASON: Record<AdaptationTrigger, string> = {
  INITIAL_GENERATION: "",
  MISSED_SESSIONS: "You missed some planned study sessions, so the remaining plan has been redistributed.",
  LOW_PERFORMANCE: "Your recent performance changed, so priorities have been updated.",
  DEADLINE_CHANGE: "Your deadline changed, so the plan has been recalculated.",
  KNOWLEDGE_CHANGE: "Your knowledge state has changed meaningfully, so priorities have been updated.",
  MANUAL_REPLAN: "You asked for an updated plan based on your current progress.",
  TIME_AVAILABILITY_CHANGE: "Your available study time changed, so future sessions have been recalculated.",
};

/**
 * Replans an active roadmap (Phase 15 §36-38, extended by Phase 16 §29-31,
 * §37) — reuses the exact same course/goal/scope by default, but re-runs
 * the full deterministic pipeline (knowledge-gap analysis, time budget, AI
 * call) against CURRENT knowledge state. Completed work is never
 * re-explained or special-cased: because calculateConceptValue() already
 * scores by current mastery, a concept the student genuinely improved on
 * naturally drops in priority on its own. Overdue/completed/missed-minute
 * counts are surfaced to the AI honestly. The old roadmap is archived,
 * never deleted (createStudyRoadmap sets `replacesRoadmapId` and flips the
 * old row's status inside the same transaction).
 *
 * `deadline`/`minutesPerDay`/`studyDays` overrides (Phase 16 §30-31) are
 * the entry points for "change my deadline" / "change my available time" —
 * both produce a new roadmap VERSION rather than mutating the current one
 * in place, consistent with the rest of this phase's versioning model.
 */
export async function replanStudyRoadmap(userId: string, roadmapId: string, options: ReplanOptions = {}) {
  const roadmap = await prisma.studyRoadmap.findFirst({
    where: { id: roadmapId, userId },
    include: { items: { where: { isMilestone: false } }, scopeDocuments: true },
  });
  if (!roadmap) throw new RoadmapNotFoundError();
  if (roadmap.status !== "ACTIVE") throw new RoadmapNotActiveError();

  const now = new Date();
  const overdueCount = roadmap.items.filter((i) => i.status === "PENDING" && i.scheduledDate != null && i.scheduledDate < now).length;
  const completedCount = roadmap.items.filter((i) => i.status === "COMPLETED").length;
  const missed = await getMissedWorkSummary(userId, roadmapId, now);

  const requestedDeadline = "deadline" in options ? options.deadline : roadmap.deadline;
  const deadline = requestedDeadline && requestedDeadline.getTime() > now.getTime() ? requestedDeadline : null;

  const trigger = options.trigger ?? "MANUAL_REPLAN";

  return createStudyRoadmap(userId, {
    courseId: roadmap.courseId,
    goal: roadmap.goal,
    targetScore: roadmap.targetScore,
    deadline,
    minutesPerDay: options.minutesPerDay ?? roadmap.minutesPerDay,
    studyDays: options.studyDays ?? (Array.isArray(roadmap.studyDays) ? (roadmap.studyDays as number[]) : []),
    scope: reconstructScope(roadmap),
    replacesRoadmapId: roadmap.id,
    replanContext: { overdueCount, completedCount, missedMinutes: missed?.missedMinutes ?? 0 },
    adaptationTrigger: trigger,
    adaptationReason: options.reason ?? DEFAULT_REASON[trigger],
  });
}
