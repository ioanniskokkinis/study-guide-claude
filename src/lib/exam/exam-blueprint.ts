import type { ConceptMasterySummary, MasteryBucket } from "@/lib/services/student-knowledge";
import { bucketForStatus } from "@/lib/services/student-knowledge";
import {
  DEFAULT_COGNITIVE_DISTRIBUTION,
  DEFAULT_DIAGNOSTIC_RATIOS,
  MAX_SINGLE_CONCEPT_SHARE,
  MIN_QUESTIONS_PER_CONCEPT,
} from "./config";
import type { CognitiveLevelValue, ExamBlueprint, ExamBlueprintEntry, ExamConfig } from "./types";

/**
 * Deterministic exam blueprint generation (spec §5-6, §10-11) — no Claude
 * calls. Consumes the Student Knowledge Model (ConceptMasterySummary rows,
 * already computed by Phase 4's mastery engine) to decide HOW MANY
 * questions each concept gets and at what diagnostic intensity, never
 * WHETHER a concept is weak — that's Phase 4's job, this only allocates
 * exam coverage around it.
 */

type Tier = "strong" | "medium" | "weak";

function tierFor(bucket: MasteryBucket): Tier {
  if (bucket === "strong") return "strong";
  if (bucket === "developing") return "medium";
  return "weak"; // "weak" and "unknown" both diagnose as weak — an untested concept deserves diagnostic coverage too.
}

function normalizeRatios(ratios: { strong: number; medium: number; weak: number }): { strong: number; medium: number; weak: number } {
  const total = ratios.strong + ratios.medium + ratios.weak;
  if (total <= 0) return DEFAULT_DIAGNOSTIC_RATIOS;
  return { strong: ratios.strong / total, medium: ratios.medium / total, weak: ratios.weak / total };
}

/** Largest-remainder rounding so integer allocations sum exactly to `total` (spec: no fractional questions). Exported for reuse by exam-generator.ts's cognitive-level assignment. */
export function allocateIntegers(shares: number[], total: number): number[] {
  if (shares.length === 0) return [];
  const raw = shares.map((s) => s * total);
  const floors = raw.map(Math.floor);
  let remaining = total - floors.reduce((a, b) => a + b, 0);

  const remainders = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < remainders.length && remaining > 0; k++) {
    result[remainders[k].i] += 1;
    remaining -= 1;
  }
  return result;
}

function evenShares(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

/** Within a tier, weaker concepts get a larger share (diagnostic tilt, spec §10) — strong-tier concepts split evenly since they're confirmation-only. */
function sharesWithinTier(concepts: ConceptMasterySummary[], tier: Tier): number[] {
  if (tier === "strong") return evenShares(concepts.length);
  const weaknesses = concepts.map((c) => 1 - c.overallMastery);
  const totalWeakness = weaknesses.reduce((a, b) => a + b, 0);
  if (totalWeakness <= 0) return evenShares(concepts.length);
  return weaknesses.map((w) => w / totalWeakness);
}

/**
 * Redistributes any concept's allocation above MAX_SINGLE_CONCEPT_SHARE
 * (spec §6) to the other concepts, proportional to their existing share,
 * repeating until stable or no room remains (e.g. a single-concept retest
 * legitimately gets 100%).
 */
function capAndRedistribute(counts: number[], total: number): number[] {
  if (counts.length <= 1) return counts;
  const cap = Math.max(MIN_QUESTIONS_PER_CONCEPT, Math.floor(total * MAX_SINGLE_CONCEPT_SHARE));
  const result = [...counts];

  for (let pass = 0; pass < counts.length; pass++) {
    let overflow = 0;
    const overIdx: number[] = [];
    const underIdx: number[] = [];
    result.forEach((c, i) => {
      if (c > cap) {
        overflow += c - cap;
        overIdx.push(i);
      } else {
        underIdx.push(i);
      }
    });
    if (overflow === 0 || underIdx.length === 0) break;

    overIdx.forEach((i) => (result[i] = cap));
    const added = allocateIntegers(evenShares(underIdx.length), overflow);
    underIdx.forEach((i, k) => (result[i] += added[k]));
  }

  return result;
}

export interface BuildBlueprintParams {
  config: ExamConfig;
  concepts: ConceptMasterySummary[];
}

/**
 * Builds the ExamBlueprint (spec §5): allocates `config.questionCount`
 * across the given concepts, tilted toward weak/medium-mastery concepts
 * (diagnostic coverage) while never dropping strong concepts entirely
 * (confirmation coverage, spec §10).
 */
export function buildExamBlueprint(params: BuildBlueprintParams): ExamBlueprint {
  const { config } = params;
  const candidates =
    config.targetConceptIds && config.targetConceptIds.length > 0
      ? params.concepts.filter((c) => config.targetConceptIds!.includes(c.conceptId))
      : params.concepts;

  const diagnosticRatios = normalizeRatios(config.coverage?.diagnosticRatios ?? DEFAULT_DIAGNOSTIC_RATIOS);
  const cognitiveDistribution: Record<CognitiveLevelValue, number> = {
    ...DEFAULT_COGNITIVE_DISTRIBUTION,
    ...(config.coverage?.cognitiveDistribution ?? {}),
  };

  if (candidates.length === 0) {
    return { entries: [], totalQuestions: 0, diagnosticRatios, cognitiveDistribution };
  }

  const byTier: Record<Tier, ConceptMasterySummary[]> = { strong: [], medium: [], weak: [] };
  for (const c of candidates) byTier[tierFor(bucketForStatus(c.status))].push(c);

  // Tiers with no concepts don't consume budget — their share is redistributed proportionally among the tiers that do exist.
  const activeTiers = (Object.keys(byTier) as Tier[]).filter((t) => byTier[t].length > 0);
  const activeRatioTotal = activeTiers.reduce((sum, t) => sum + diagnosticRatios[t], 0);
  const tierBudgets =
    activeRatioTotal > 0
      ? allocateIntegers(
          activeTiers.map((t) => diagnosticRatios[t] / activeRatioTotal),
          config.questionCount,
        )
      : [];

  const entries: ExamBlueprintEntry[] = [];
  const allCounts: number[] = [];
  const allConcepts: ConceptMasterySummary[] = [];

  activeTiers.forEach((tier, tierIdx) => {
    const tierConcepts = byTier[tier];
    const tierBudget = tierBudgets[tierIdx] ?? 0;
    const shares = sharesWithinTier(tierConcepts, tier);
    const counts = allocateIntegers(shares, tierBudget);

    tierConcepts.forEach((c, i) => {
      allCounts.push(counts[i]);
      allConcepts.push(c);
    });
  });

  const capped = capAndRedistribute(allCounts, config.questionCount);

  allConcepts.forEach((c, i) => {
    const questionCount = capped[i];
    if (questionCount <= 0) return;
    entries.push({
      conceptId: c.conceptId,
      conceptName: c.conceptName,
      weight: questionCount / config.questionCount,
      questionCount,
      tier: tierFor(bucketForStatus(c.status)),
      cognitiveDistribution,
    });
  });

  const totalQuestions = entries.reduce((sum, e) => sum + e.questionCount, 0);
  return { entries, totalQuestions, diagnosticRatios, cognitiveDistribution };
}
