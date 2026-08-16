import { clamp01 } from "@/lib/learning/mastery-engine";
import type { ConceptPriority } from "./knowledge-gaps";
import type { PerformanceTrend, TrendResult } from "./trends";

/**
 * Phase 16 §11 — "Priority = importance × weakness × urgency ×
 * prerequisiteImpact × recency". importance/weakness/prerequisiteImpact/
 * recency are ALREADY exactly what Phase 6's `calculateConceptValue()`
 * computes (`breakdown.value` in `ConceptPriority`, Phase 15) — this module
 * does not recompute or duplicate any of that. It only multiplies the
 * existing `value` by two Phase-16-specific signals `calculateConceptValue`
 * has no way to know about (a deadline urgency score, and a per-concept
 * performance trend), producing an *adaptation-specific* ranking used only
 * by recovery planning / next-best-action / significant-change detection —
 * never by initial roadmap generation (Phase 15's `analyzeKnowledgeGaps` is
 * untouched and still the sole source for that).
 */

export interface AdaptiveConceptPriority extends ConceptPriority {
  trend: PerformanceTrend;
  /** breakdown.value adjusted by trend + urgency — used for ranking only within adaptation decisions. */
  adaptiveValue: number;
}

/** Declining performance raises priority (spec §6's "declining + important -> increase priority"); confidently improving performance lowers it slightly (spec §6/§13's mastery-based deprioritization) — insufficient data is neutral, never treated as a negative signal. */
const TREND_MULTIPLIER: Record<PerformanceTrend, number> = {
  DECLINING: 1.25,
  STABLE: 1.0,
  IMPROVING: 0.85,
  INSUFFICIENT_DATA: 1.0,
};

/** Urgency can boost adjusted value by up to 50% at maximum urgency (urgencyScore=1) — a meaningful but bounded nudge, never enough to make a genuinely mastered concept outrank a weak one on its own. */
const MAX_URGENCY_BOOST = 0.5;

export function applyAdaptiveAdjustments(
  priorities: ConceptPriority[],
  trends: Map<string, TrendResult>,
  urgencyScore: number,
): AdaptiveConceptPriority[] {
  const urgencyMultiplier = 1 + urgencyScore * MAX_URGENCY_BOOST;

  return priorities
    .map((priority) => {
      const trend = trends.get(priority.conceptId)?.trend ?? "INSUFFICIENT_DATA";
      const adaptiveValue = clamp01(priority.breakdown.value * TREND_MULTIPLIER[trend] * urgencyMultiplier);
      return { ...priority, trend, adaptiveValue };
    })
    .sort((a, b) => b.adaptiveValue - a.adaptiveValue);
}
