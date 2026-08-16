import { clamp01 } from "@/lib/learning/mastery-engine";
import { getRoadmap } from "./queries";
import { getRoadmapProgress } from "./progress";
import { HEALTH_AT_RISK_MARGIN, HEALTH_BEHIND_MARGIN, HEALTH_MIN_ELAPSED_RATIO } from "./config";

/**
 * Deterministic roadmap health (Phase 16 §40) — compares actual progress
 * (Phase 15's `getRoadmapProgress`, unchanged) to the progress "expected"
 * from how much of the roadmap's own time window has elapsed. No arbitrary
 * claims: every threshold is a named constant in config.ts, and a roadmap
 * with no end date, no items, or too little elapsed time to judge fairly
 * reports INSUFFICIENT_DATA rather than guessing.
 */
export type RoadmapHealth = "ON_TRACK" | "AT_RISK" | "BEHIND" | "INSUFFICIENT_DATA";

export interface HealthResult {
  health: RoadmapHealth;
  /** 0-1 — how far through the roadmap's time window "should" have been completed by now, linear in elapsed time. Null when health is INSUFFICIENT_DATA because there's no valid window to measure against. */
  expectedProgressPercent: number | null;
  actualProgressPercent: number;
}

export function calculateRoadmapHealth(params: {
  startDate: Date;
  endDate: Date | null;
  now: Date;
  actualProgressPercent: number;
  totalItems: number;
}): HealthResult {
  if (params.totalItems === 0 || !params.endDate) {
    return { health: "INSUFFICIENT_DATA", expectedProgressPercent: null, actualProgressPercent: params.actualProgressPercent };
  }

  const totalMs = params.endDate.getTime() - params.startDate.getTime();
  if (totalMs <= 0) {
    return { health: "INSUFFICIENT_DATA", expectedProgressPercent: null, actualProgressPercent: params.actualProgressPercent };
  }

  const elapsedRatio = clamp01((params.now.getTime() - params.startDate.getTime()) / totalMs);
  if (elapsedRatio < HEALTH_MIN_ELAPSED_RATIO) {
    return { health: "INSUFFICIENT_DATA", expectedProgressPercent: elapsedRatio, actualProgressPercent: params.actualProgressPercent };
  }

  const gap = elapsedRatio - params.actualProgressPercent;
  const health: RoadmapHealth = gap <= HEALTH_AT_RISK_MARGIN ? "ON_TRACK" : gap <= HEALTH_BEHIND_MARGIN ? "AT_RISK" : "BEHIND";

  return { health, expectedProgressPercent: elapsedRatio, actualProgressPercent: params.actualProgressPercent };
}

/** Returns null if the roadmap doesn't exist or isn't owned by `userId`. */
export async function getRoadmapHealthForRoadmap(userId: string, roadmapId: string, now: Date = new Date()): Promise<HealthResult | null> {
  const [roadmap, progress] = await Promise.all([getRoadmap(userId, roadmapId), getRoadmapProgress(userId, roadmapId)]);
  if (!roadmap || !progress) return null;

  return calculateRoadmapHealth({
    startDate: roadmap.startDate,
    endDate: roadmap.endDate,
    now,
    actualProgressPercent: progress.overallProgressPercent,
    totalItems: progress.totalItems,
  });
}
