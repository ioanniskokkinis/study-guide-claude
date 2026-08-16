import { describe, expect, it } from "vitest";
import { applyAdaptiveAdjustments } from "@/lib/advisor/adaptive-priority";
import type { ConceptPriority } from "@/lib/advisor/knowledge-gaps";
import type { TrendResult } from "@/lib/advisor/trends";

/**
 * Phase 16 §11, §57 — the adaptive priority layer multiplies Phase 6/15's
 * existing `breakdown.value`, it never recomputes it. These tests fix
 * `breakdown.value` and vary only trend/urgency to isolate the multiplier
 * logic this module actually owns.
 */
function priority(conceptId: string, value: number): ConceptPriority {
  return {
    conceptId,
    conceptName: conceptId,
    breakdown: {
      conceptId,
      weakness: value,
      prerequisiteImportance: 0,
      mistakeScore: 0,
      forgettingRisk: 0,
      goalRelevance: 0,
      recencyPenalty: 0,
      value,
      block: { blocked: false, blockingConceptId: null, blockingConceptName: null, blockingMastery: null },
    },
    masteryPercent: 1 - value,
    recentAccuracy: null,
  };
}

function trend(t: TrendResult["trend"]): TrendResult {
  return { trend: t, recentAverage: null, priorAverage: null, observationCount: 5 };
}

describe("applyAdaptiveAdjustments", () => {
  it("boosts a declining concept's adaptive value above its base value", () => {
    const [result] = applyAdaptiveAdjustments([priority("c1", 0.4)], new Map([["c1", trend("DECLINING")]]), 0);
    expect(result.adaptiveValue).toBeGreaterThan(0.4);
    expect(result.trend).toBe("DECLINING");
  });

  it("lowers an improving concept's adaptive value below its base value (mastery-based deprioritization)", () => {
    const [result] = applyAdaptiveAdjustments([priority("c1", 0.4)], new Map([["c1", trend("IMPROVING")]]), 0);
    expect(result.adaptiveValue).toBeLessThan(0.4);
  });

  it("leaves a stable concept's adaptive value unchanged at zero urgency", () => {
    const [result] = applyAdaptiveAdjustments([priority("c1", 0.4)], new Map([["c1", trend("STABLE")]]), 0);
    expect(result.adaptiveValue).toBeCloseTo(0.4, 5);
  });

  it("treats a concept with no trend data as neutral (INSUFFICIENT_DATA), never as a negative signal", () => {
    const [result] = applyAdaptiveAdjustments([priority("c1", 0.4)], new Map(), 0);
    expect(result.trend).toBe("INSUFFICIENT_DATA");
    expect(result.adaptiveValue).toBeCloseTo(0.4, 5);
  });

  it("raises adaptive value as urgency increases", () => {
    const low = applyAdaptiveAdjustments([priority("c1", 0.4)], new Map([["c1", trend("STABLE")]]), 0)[0];
    const high = applyAdaptiveAdjustments([priority("c1", 0.4)], new Map([["c1", trend("STABLE")]]), 1)[0];
    expect(high.adaptiveValue).toBeGreaterThan(low.adaptiveValue);
  });

  it("never exceeds an adaptive value of 1 even at maximum trend and urgency boost", () => {
    const [result] = applyAdaptiveAdjustments([priority("c1", 0.95)], new Map([["c1", trend("DECLINING")]]), 1);
    expect(result.adaptiveValue).toBeLessThanOrEqual(1);
  });

  it("ranks a weak+declining+urgent concept above a strong+stable concept", () => {
    const weak = priority("weak", 0.8);
    const strong = priority("strong", 0.2);
    const trends = new Map([
      ["weak", trend("DECLINING")],
      ["strong", trend("STABLE")],
    ]);
    const [first, second] = applyAdaptiveAdjustments([strong, weak], trends, 0.5);
    expect(first.conceptId).toBe("weak");
    expect(second.conceptId).toBe("strong");
  });

  it("preserves prerequisite-block information from the underlying breakdown untouched", () => {
    const blocked = priority("c1", 0.5);
    blocked.breakdown.block = { blocked: true, blockingConceptId: "prereq-1", blockingConceptName: "Prereq", blockingMastery: 0.1 };
    const [result] = applyAdaptiveAdjustments([blocked], new Map(), 0);
    expect(result.breakdown.block.blockingConceptId).toBe("prereq-1");
  });
});
