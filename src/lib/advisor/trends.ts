import { prisma } from "@/lib/db/prisma";
import { TREND_MIN_OBSERVATIONS, TREND_RECENT_WINDOW_SIZE, TREND_SIGNIFICANT_DELTA } from "./config";

/**
 * Deterministic performance-trend calculation (Phase 16 §5-6) — no ML
 * model, just a windowed average comparison over `KnowledgeEvidence.score`
 * (Phase 4's own immutable evidence log — never a new evidence source).
 * Requires at least `TREND_MIN_OBSERVATIONS` data points before calling a
 * direction at all, specifically to avoid overreacting to one question
 * (spec §5).
 */

export type PerformanceTrend = "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";

export interface TrendResult {
  trend: PerformanceTrend;
  recentAverage: number | null;
  priorAverage: number | null;
  observationCount: number;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Pure function: takes evidence scores ordered oldest-first, returns a trend. Independently testable, no DB access. */
export function calculatePerformanceTrend(scoresOldestFirst: number[]): TrendResult {
  const observationCount = scoresOldestFirst.length;
  if (observationCount < TREND_MIN_OBSERVATIONS) {
    return { trend: "INSUFFICIENT_DATA", recentAverage: null, priorAverage: null, observationCount };
  }

  const recentWindowSize = Math.min(TREND_RECENT_WINDOW_SIZE, Math.floor(observationCount / 2));
  const recent = scoresOldestFirst.slice(observationCount - recentWindowSize);
  const prior = scoresOldestFirst.slice(0, observationCount - recentWindowSize);

  const recentAverage = average(recent);
  const priorAverage = average(prior);
  const delta = recentAverage - priorAverage;

  const trend: PerformanceTrend =
    delta >= TREND_SIGNIFICANT_DELTA ? "IMPROVING" : delta <= -TREND_SIGNIFICANT_DELTA ? "DECLINING" : "STABLE";

  return { trend, recentAverage, priorAverage, observationCount };
}

/** DB-aware wrapper: loads a concept's evidence history (oldest-first) and computes its trend. Does not check ownership itself — callers must have already verified the concept belongs to `userId`. */
export async function getConceptPerformanceTrend(userId: string, conceptId: string): Promise<TrendResult> {
  const evidence = await prisma.knowledgeEvidence.findMany({
    where: { userId, conceptId },
    orderBy: { createdAt: "asc" },
    select: { score: true },
  });
  return calculatePerformanceTrend(evidence.map((e) => e.score));
}

/** Batch variant — one query for every concept in `conceptIds`, grouped in memory (avoids N+1, spec §51). */
export async function getConceptPerformanceTrends(userId: string, conceptIds: string[]): Promise<Map<string, TrendResult>> {
  if (conceptIds.length === 0) return new Map();

  const evidence = await prisma.knowledgeEvidence.findMany({
    where: { userId, conceptId: { in: conceptIds } },
    orderBy: { createdAt: "asc" },
    select: { conceptId: true, score: true },
  });

  const scoresByConceptId = new Map<string, number[]>();
  for (const e of evidence) {
    const list = scoresByConceptId.get(e.conceptId) ?? [];
    list.push(e.score);
    scoresByConceptId.set(e.conceptId, list);
  }

  const results = new Map<string, TrendResult>();
  for (const conceptId of conceptIds) {
    results.set(conceptId, calculatePerformanceTrend(scoresByConceptId.get(conceptId) ?? []));
  }
  return results;
}
