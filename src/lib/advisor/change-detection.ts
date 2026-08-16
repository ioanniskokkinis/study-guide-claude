import { prisma } from "@/lib/db/prisma";
import type { AdaptationTrigger } from "@/generated/prisma/client";
import { getMissedWorkSummary } from "./missed-work";
import { getConceptPerformanceTrends } from "./trends";
import { SIGNIFICANT_MASTERY_SWING, SIGNIFICANT_MISSED_ITEMS, SIGNIFICANT_NEW_EVIDENCE_COUNT } from "./config";

/**
 * Deterministic significant-change detection (Phase 16 §21-22) — purely DB
 * reads and arithmetic, never an AI call. This is the gate that decides
 * whether replanning is even worth suggesting; it does not itself replan
 * anything. Every check is windowed against `roadmap.lastEvaluatedAt` (or
 * the roadmap's own `startDate` if it has never been evaluated) so the same
 * evidence is never double-counted across repeated checks — see
 * `markRoadmapEvaluated()` below.
 */
export interface AdaptationCheckResult {
  needed: boolean;
  triggers: AdaptationTrigger[];
  /** Human-readable, one sentence per trigger — no internal thresholds or raw numbers beyond what a student would understand. */
  details: string[];
}

export class RoadmapNotFoundForCheckError extends Error {
  constructor() {
    super("Roadmap not found.");
  }
}

export async function checkAdaptationNeeded(userId: string, roadmapId: string, now: Date = new Date()): Promise<AdaptationCheckResult> {
  const roadmap = await prisma.studyRoadmap.findFirst({ where: { id: roadmapId, userId } });
  if (!roadmap) throw new RoadmapNotFoundForCheckError();

  // A paused, archived, or already-completed roadmap is never a candidate for automatic adaptation (spec §32).
  if (roadmap.status !== "ACTIVE") {
    return { needed: false, triggers: [], details: [] };
  }

  const since = roadmap.lastEvaluatedAt ?? roadmap.startDate;
  const triggers: AdaptationTrigger[] = [];
  const details: string[] = [];

  const items = await prisma.studyRoadmapItem.findMany({
    where: { roadmapId, isMilestone: false, conceptId: { not: null } },
    select: { conceptId: true, baselineMastery: true },
  });
  const conceptIds = Array.from(new Set(items.map((i) => i.conceptId).filter((id): id is string => id !== null)));

  const missed = await getMissedWorkSummary(userId, roadmapId, now);
  if (missed && missed.missedSessionsCount >= SIGNIFICANT_MISSED_ITEMS) {
    triggers.push("MISSED_SESSIONS");
    details.push(`${missed.missedSessionsCount} planned study sessions were missed.`);
  }

  if (conceptIds.length > 0) {
    const [newEvidenceCount, masteries, trends] = await Promise.all([
      prisma.knowledgeEvidence.count({ where: { userId, conceptId: { in: conceptIds }, createdAt: { gt: since } } }),
      prisma.studentConceptMastery.findMany({ where: { userId, conceptId: { in: conceptIds } }, select: { conceptId: true, overallMastery: true } }),
      getConceptPerformanceTrends(userId, conceptIds),
    ]);

    const masteryByConceptId = new Map(masteries.map((m) => [m.conceptId, m.overallMastery]));
    const masteryShifted = items.some((item) => {
      if (item.baselineMastery == null || !item.conceptId) return false;
      const current = masteryByConceptId.get(item.conceptId) ?? item.baselineMastery;
      return Math.abs(current - item.baselineMastery) >= SIGNIFICANT_MASTERY_SWING;
    });

    if (newEvidenceCount >= SIGNIFICANT_NEW_EVIDENCE_COUNT || masteryShifted) {
      triggers.push("KNOWLEDGE_CHANGE");
      details.push(
        masteryShifted
          ? "Your mastery on at least one topic has changed meaningfully since this plan was made."
          : `${newEvidenceCount} new study observations have been recorded since this plan was made.`,
      );
    }

    const decliningCount = Array.from(trends.values()).filter((t) => t.trend === "DECLINING").length;
    if (decliningCount > 0) {
      triggers.push("LOW_PERFORMANCE");
      details.push(`Recent performance is declining on ${decliningCount} topic${decliningCount === 1 ? "" : "s"} in this plan.`);
    }
  }

  return { needed: triggers.length > 0, triggers, details };
}

/**
 * Stamps the roadmap as evaluated "now," resetting the "new evidence since"
 * window `checkAdaptationNeeded` uses. `createStudyRoadmap` already does
 * this itself whenever a roadmap is (re)generated, which is the only place
 * this actually needs to happen in the current flow — `checkAdaptationNeeded`
 * itself stays a pure read (a GET request should never have this side
 * effect). Exported as its own function for any future flow that needs to
 * reset the window without generating a whole new roadmap version (e.g. an
 * explicit "dismiss this notification" action).
 */
export async function markRoadmapEvaluated(roadmapId: string, now: Date = new Date()): Promise<void> {
  await prisma.studyRoadmap.update({ where: { id: roadmapId }, data: { lastEvaluatedAt: now } });
}
