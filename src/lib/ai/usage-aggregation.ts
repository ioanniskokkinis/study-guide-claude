import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Reusable aggregation queries over `AiUsageLog` (Phase 12 §14). Not an
 * admin dashboard yet — just the functions a later SaaS/admin phase will
 * call directly. Every function accepts the same optional filter so
 * "cost this week", "cost for this user", etc. all compose the same way.
 */
export interface UsageAggregationFilter {
  since?: Date;
  until?: Date;
  userId?: string;
}

function whereClause(filter: UsageAggregationFilter = {}): Prisma.AiUsageLogWhereInput {
  return {
    userId: filter.userId,
    createdAt: {
      gte: filter.since,
      lte: filter.until,
    },
  };
}

export async function getTotalAiCost(filter?: UsageAggregationFilter): Promise<number> {
  const result = await prisma.aiUsageLog.aggregate({
    where: whereClause(filter),
    _sum: { estimatedCostUsd: true },
  });
  return result._sum.estimatedCostUsd ?? 0;
}

export interface ModelCostBreakdown {
  model: string;
  totalCostUsd: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
}

export async function getCostByModel(filter?: UsageAggregationFilter): Promise<ModelCostBreakdown[]> {
  const rows = await prisma.aiUsageLog.groupBy({
    by: ["model"],
    where: whereClause(filter),
    _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
    orderBy: { _sum: { estimatedCostUsd: "desc" } },
  });
  return rows.map((r) => ({
    model: r.model,
    totalCostUsd: r._sum.estimatedCostUsd ?? 0,
    requestCount: r._count._all,
    inputTokens: r._sum.inputTokens ?? 0,
    outputTokens: r._sum.outputTokens ?? 0,
  }));
}

export interface OperationBreakdown {
  operation: string;
  totalCostUsd: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  averageCostUsd: number;
  averageTokensPerRequest: number;
}

/** Cost, token totals, and per-request averages grouped by `requestType` (the "operation" — spec's naming). */
export async function getCostByOperation(filter?: UsageAggregationFilter): Promise<OperationBreakdown[]> {
  const rows = await prisma.aiUsageLog.groupBy({
    by: ["requestType"],
    where: whereClause(filter),
    _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
    orderBy: { _sum: { estimatedCostUsd: "desc" } },
  });
  return rows.map((r) => {
    const totalCostUsd = r._sum.estimatedCostUsd ?? 0;
    const inputTokens = r._sum.inputTokens ?? 0;
    const outputTokens = r._sum.outputTokens ?? 0;
    const requestCount = r._count._all;
    return {
      operation: r.requestType,
      totalCostUsd,
      requestCount,
      inputTokens,
      outputTokens,
      averageCostUsd: requestCount > 0 ? totalCostUsd / requestCount : 0,
      averageTokensPerRequest: requestCount > 0 ? (inputTokens + outputTokens) / requestCount : 0,
    };
  });
}

/** Same grouping as `getCostByOperation`, sorted by total cost descending — "most expensive operations" (spec §14). */
export async function getMostExpensiveOperations(limit = 5, filter?: UsageAggregationFilter): Promise<OperationBreakdown[]> {
  const breakdown = await getCostByOperation(filter);
  return breakdown.slice(0, limit);
}

export interface DailyRequestCount {
  date: string;
  requestCount: number;
  totalCostUsd: number;
}

/** Requests/day (spec §14) — computed in JS from raw rows rather than a DB-specific date-trunc function, to stay portable across the Prisma driver adapters already in use. */
export async function getRequestsPerDay(filter?: UsageAggregationFilter): Promise<DailyRequestCount[]> {
  const rows = await prisma.aiUsageLog.findMany({
    where: whereClause(filter),
    select: { createdAt: true, estimatedCostUsd: true },
  });

  const byDay = new Map<string, { requestCount: number; totalCostUsd: number }>();
  for (const row of rows) {
    const date = row.createdAt.toISOString().slice(0, 10);
    const existing = byDay.get(date) ?? { requestCount: 0, totalCostUsd: 0 };
    existing.requestCount += 1;
    existing.totalCostUsd += row.estimatedCostUsd;
    byDay.set(date, existing);
  }

  return Array.from(byDay.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface UsageSummary {
  totalCostUsd: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageCostPerRequest: number;
  averageTokensPerRequest: number;
}

/** One-shot overview combining the totals a cost dashboard's headline numbers would need (spec §14: total cost, average tokens/request, average cost/request). */
export async function getUsageSummary(filter?: UsageAggregationFilter): Promise<UsageSummary> {
  const where = whereClause(filter);
  const [totals, successCount, failureCount] = await Promise.all([
    prisma.aiUsageLog.aggregate({
      where,
      _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
    }),
    prisma.aiUsageLog.count({ where: { ...where, success: true } }),
    prisma.aiUsageLog.count({ where: { ...where, success: false } }),
  ]);

  const totalRequests = totals._count._all;
  const totalCostUsd = totals._sum.estimatedCostUsd ?? 0;
  const totalTokens = (totals._sum.inputTokens ?? 0) + (totals._sum.outputTokens ?? 0);

  return {
    totalCostUsd,
    totalRequests,
    successfulRequests: successCount,
    failedRequests: failureCount,
    averageCostPerRequest: totalRequests > 0 ? totalCostUsd / totalRequests : 0,
    averageTokensPerRequest: totalRequests > 0 ? totalTokens / totalRequests : 0,
  };
}
