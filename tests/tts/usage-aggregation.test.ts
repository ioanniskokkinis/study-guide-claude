import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { getTtsUsageByVoice, getTtsUsageSummary } from "@/lib/tts/usage-aggregation";

/**
 * Phase 14 §20-22 — TTS usage/cost aggregation, kept separate from Phase
 * 12's AiUsageLog aggregation (different table, character-based not
 * token-based). Pure DB reads over directly-seeded rows, same pattern as
 * tests/ai/pricing-and-usage.test.ts's "usage aggregation" block.
 */
describe("TTS usage aggregation (Phase 14 §20-22)", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `tts-usage-${suffix}@example.com` } });
    userId = user.id;

    await prisma.ttsUsageLog.createMany({
      data: [
        {
          userId,
          provider: "openai",
          model: "tts-1",
          voice: "alloy",
          characterCount: 100,
          estimatedCostUsd: 0.0015,
          latencyMs: 300,
          cacheHit: false,
          success: true,
        },
        {
          userId,
          provider: "openai",
          model: "tts-1",
          voice: "alloy",
          characterCount: 80,
          estimatedCostUsd: 0,
          latencyMs: 20,
          cacheHit: true,
          success: true,
        },
        {
          userId,
          provider: "openai",
          model: "tts-1",
          voice: "verse",
          characterCount: 200,
          estimatedCostUsd: 0.003,
          latencyMs: 500,
          cacheHit: false,
          success: true,
        },
        {
          userId,
          provider: "openai",
          model: "tts-1",
          voice: "alloy",
          characterCount: 0,
          estimatedCostUsd: 0,
          latencyMs: 100,
          cacheHit: false,
          success: false,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.ttsUsageLog.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("getTtsUsageSummary reports totals, cache-hit rate, characters, cost, and average latency", async () => {
    const summary = await getTtsUsageSummary({ userId });
    expect(summary.totalRequests).toBe(4);
    expect(summary.successfulRequests).toBe(3);
    expect(summary.failedRequests).toBe(1);
    expect(summary.cacheHits).toBe(1);
    expect(summary.cacheMisses).toBe(3);
    expect(summary.cacheHitRate).toBeCloseTo(0.25, 5);
    expect(summary.charactersSynthesized).toBe(380);
    expect(summary.totalCostUsd).toBeCloseTo(0.0045, 6);
    expect(summary.averageLatencyMs).toBeCloseTo((300 + 20 + 500 + 100) / 4, 5);
  });

  it("getTtsUsageByVoice groups requests, characters, and cost per voice", async () => {
    const byVoice = await getTtsUsageByVoice({ userId });
    const alloy = byVoice.find((v) => v.voice === "alloy");
    const verse = byVoice.find((v) => v.voice === "verse");
    expect(alloy?.requestCount).toBe(3);
    expect(verse?.requestCount).toBe(1);
    expect(verse?.totalCostUsd).toBeCloseTo(0.003, 6);
  });
});
