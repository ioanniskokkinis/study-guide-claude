import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Reusable TTS usage/cost aggregation queries (Phase 14 §20-22) — the TTS
 * counterpart of src/lib/ai/usage-aggregation.ts (Phase 12), reading
 * `TtsUsageLog` instead of `AiUsageLog` so TTS numbers are never summed
 * together with Claude token costs. Not an admin dashboard UI (none
 * exists yet in this codebase, matching Phase 12's own "functions only,
 * no UI" precedent) — these are the functions a future admin/SaaS phase
 * calls directly for the "TTS Requests / Cache Hit Rate / Characters
 * Synthesized / Estimated TTS Cost / Average TTS Latency" section spec §22
 * describes.
 */
export interface TtsUsageFilter {
  since?: Date;
  until?: Date;
  userId?: string;
}

function whereClause(filter: TtsUsageFilter = {}): Prisma.TtsUsageLogWhereInput {
  return {
    userId: filter.userId,
    createdAt: {
      gte: filter.since,
      lte: filter.until,
    },
  };
}

export interface TtsUsageSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  charactersSynthesized: number;
  totalCostUsd: number;
  averageLatencyMs: number;
}

/** The headline numbers spec §22's admin TTS section describes, in one query round-trip set. */
export async function getTtsUsageSummary(filter?: TtsUsageFilter): Promise<TtsUsageSummary> {
  const where = whereClause(filter);
  const [totals, cacheHitCount, cacheMissCount, successCount, failureCount] = await Promise.all([
    prisma.ttsUsageLog.aggregate({
      where,
      _sum: { estimatedCostUsd: true, characterCount: true, latencyMs: true },
      _count: { _all: true },
    }),
    prisma.ttsUsageLog.count({ where: { ...where, cacheHit: true } }),
    prisma.ttsUsageLog.count({ where: { ...where, cacheHit: false } }),
    prisma.ttsUsageLog.count({ where: { ...where, success: true } }),
    prisma.ttsUsageLog.count({ where: { ...where, success: false } }),
  ]);

  const totalRequests = totals._count._all;

  return {
    totalRequests,
    successfulRequests: successCount,
    failedRequests: failureCount,
    cacheHits: cacheHitCount,
    cacheMisses: cacheMissCount,
    cacheHitRate: totalRequests > 0 ? cacheHitCount / totalRequests : 0,
    charactersSynthesized: totals._sum.characterCount ?? 0,
    totalCostUsd: totals._sum.estimatedCostUsd ?? 0,
    averageLatencyMs: totalRequests > 0 ? (totals._sum.latencyMs ?? 0) / totalRequests : 0,
  };
}

export interface TtsVoiceBreakdown {
  voice: string;
  requestCount: number;
  charactersSynthesized: number;
  totalCostUsd: number;
}

/** Usage grouped by voice — useful once more than one voice is offered (spec §15). */
export async function getTtsUsageByVoice(filter?: TtsUsageFilter): Promise<TtsVoiceBreakdown[]> {
  const rows = await prisma.ttsUsageLog.groupBy({
    by: ["voice"],
    where: whereClause(filter),
    _sum: { estimatedCostUsd: true, characterCount: true },
    _count: { _all: true },
    orderBy: { _sum: { estimatedCostUsd: "desc" } },
  });
  return rows.map((r) => ({
    voice: r.voice,
    requestCount: r._count._all,
    charactersSynthesized: r._sum.characterCount ?? 0,
    totalCostUsd: r._sum.estimatedCostUsd ?? 0,
  }));
}
