import { clamp01 } from "@/lib/learning/mastery-engine";
import type { ConceptMasterySummary } from "@/lib/services/student-knowledge";
import {
  EXAM_URGENCY_BANDS,
  EXAM_URGENCY_SCORES,
  FORGETTING_BASE_HALF_LIFE_DAYS,
  FORGETTING_MASTERY_HALF_LIFE_BONUS_DAYS,
  MAX_PREREQUISITE_DEPTH,
  MISTAKE_HALF_LIFE_HOURS,
  MISTAKE_RELEVANCE_WINDOW_DAYS,
  MISTAKE_SEVERITY_WEIGHT,
  PREREQUISITE_MASTERY_THRESHOLD,
  RECENCY_MAX_PENALTY,
  RECENCY_WINDOW_SIZE,
} from "./config";
import type { StudentLearningState } from "./student-state";

/**
 * Per-concept scoring components (spec §6-17). Each function is independent
 * and independently testable — calculateConceptValue() at the bottom is
 * the only place they're combined, so the combination itself stays a
 * single, inspectable formula rather than a black box (spec §47).
 */

// ---------------------------------------------------------------------------
// Weakness (spec §7)
// ---------------------------------------------------------------------------

/** 0 = mastered, 1 = fully weak/unknown. A concept never attempted defaults to mastery 0, so it reads as maximally weak — that's intentional (weakness, not forgetting, spec §13). */
export function calculateWeaknessScore(mastery: ConceptMasterySummary | undefined): number {
  return clamp01(1 - (mastery?.overallMastery ?? 0));
}

// ---------------------------------------------------------------------------
// Prerequisites (spec §8-10)
// ---------------------------------------------------------------------------

export interface PrerequisiteBlockResult {
  blocked: boolean;
  blockingConceptId: string | null;
  blockingConceptName: string | null;
  blockingMastery: number | null;
}

function collectAncestors(
  conceptId: string,
  state: StudentLearningState,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
  out: Array<{ conceptId: string; mastery: number }>,
): void {
  if (depth >= maxDepth) return;
  for (const prereqId of state.prerequisitesByTarget.get(conceptId) ?? []) {
    if (visited.has(prereqId)) continue;
    visited.add(prereqId);
    out.push({ conceptId: prereqId, mastery: state.masteryByConceptId.get(prereqId)?.overallMastery ?? 0 });
    collectAncestors(prereqId, state, visited, depth + 1, maxDepth, out);
  }
}

/**
 * Is `conceptId` blocked by a weak prerequisite, anywhere in its upstream
 * chain (recursive, depth-limited — spec §8)? A concept is only "blocked"
 * when it is ITSELF still weak (< PREREQUISITE_MASTERY_THRESHOLD) — a
 * strong target with a weak prerequisite (spec §10's "prerequisite=0.35,
 * target=0.75" example) is not blocked, since the student has evidently
 * already cleared that bar despite the prerequisite's low measured score;
 * the prerequisite still gets surfaced on its own weakness merits
 * elsewhere, just not as a redirect-away-from-this-target signal.
 *
 * Among eligible weak ancestors (weak, and no stronger than the target
 * itself — genuinely the bottleneck, not a red herring), the WEAKEST one
 * is chosen as the thing to redirect to, on the theory that the most
 * foundational gap is the highest-leverage place to intervene.
 */
export function findPrerequisiteBlock(
  conceptId: string,
  state: StudentLearningState,
  maxDepth: number = MAX_PREREQUISITE_DEPTH,
): PrerequisiteBlockResult {
  const notBlocked: PrerequisiteBlockResult = {
    blocked: false,
    blockingConceptId: null,
    blockingConceptName: null,
    blockingMastery: null,
  };

  const targetMastery = state.masteryByConceptId.get(conceptId)?.overallMastery ?? 0;
  if (targetMastery >= PREREQUISITE_MASTERY_THRESHOLD) return notBlocked;

  const ancestors: Array<{ conceptId: string; mastery: number }> = [];
  collectAncestors(conceptId, state, new Set([conceptId]), 0, maxDepth, ancestors);

  const eligible = ancestors.filter((a) => a.mastery < PREREQUISITE_MASTERY_THRESHOLD && a.mastery <= targetMastery);
  if (eligible.length === 0) return notBlocked;

  const weakest = eligible.reduce((min, a) => (a.mastery < min.mastery ? a : min));
  const concept = state.concepts.find((c) => c.id === weakest.conceptId);

  return {
    blocked: true,
    blockingConceptId: weakest.conceptId,
    blockingConceptName: concept?.name ?? "a prerequisite",
    blockingMastery: weakest.mastery,
  };
}

function collectDescendants(
  conceptId: string,
  state: StudentLearningState,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
  out: string[],
): void {
  if (depth >= maxDepth) return;
  for (const [targetId, prereqIds] of state.prerequisitesByTarget.entries()) {
    if (!prereqIds.includes(conceptId) || visited.has(targetId)) continue;
    visited.add(targetId);
    out.push(targetId);
    collectDescendants(targetId, state, visited, depth + 1, maxDepth, out);
  }
}

/**
 * How much does practicing this concept matter because OTHER weak concepts
 * depend on it (spec §8)? Highest downstream weakness wins — unblocking
 * even one badly-stuck concept is what matters, not the average.
 */
export function calculatePrerequisiteImportance(
  conceptId: string,
  state: StudentLearningState,
  maxDepth: number = MAX_PREREQUISITE_DEPTH,
): number {
  const descendants: string[] = [];
  collectDescendants(conceptId, state, new Set([conceptId]), 0, maxDepth, descendants);
  if (descendants.length === 0) return 0;

  const weaknesses = descendants.map((id) => 1 - (state.masteryByConceptId.get(id)?.overallMastery ?? 0));
  return clamp01(Math.max(...weaknesses));
}

// ---------------------------------------------------------------------------
// Recent mistakes (spec §11-12)
// ---------------------------------------------------------------------------

/**
 * Time- and severity-weighted recent-mistake pressure, saturating toward 1
 * rather than growing unbounded with mistake count. A mistake older than
 * MISTAKE_RELEVANCE_WINDOW_DAYS is excluded entirely — forgetting-risk
 * scoring picks up long-term staleness instead (spec §11).
 */
export function calculateRecentMistakeScore(
  conceptId: string,
  state: StudentLearningState,
  now: Date = new Date(),
): number {
  const mistakes = state.recentMistakesByConceptId.get(conceptId) ?? [];
  let total = 0;

  for (const mistake of mistakes) {
    const ageHours = (now.getTime() - mistake.createdAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > MISTAKE_RELEVANCE_WINDOW_DAYS * 24) continue;

    const decay = Math.pow(0.5, ageHours / MISTAKE_HALF_LIFE_HOURS);
    total += decay * MISTAKE_SEVERITY_WEIGHT[mistake.severity];
  }

  return clamp01(1 - Math.exp(-total));
}

// ---------------------------------------------------------------------------
// Forgetting risk (spec §13) — deliberately separate from weakness.
// ---------------------------------------------------------------------------

/** Never-practiced concepts return 0 here — that's weakness, not forgetting (spec §13). */
export function calculateForgettingRiskScore(
  conceptId: string,
  state: StudentLearningState,
  now: Date = new Date(),
): number {
  const mastery = state.masteryByConceptId.get(conceptId);
  if (!mastery || mastery.exposureCount === 0 || !mastery.lastAttemptAt) return 0;

  const daysSince = (now.getTime() - mastery.lastAttemptAt.getTime()) / (1000 * 60 * 60 * 24);
  const halfLife = FORGETTING_BASE_HALF_LIFE_DAYS + mastery.overallMastery * FORGETTING_MASTERY_HALF_LIFE_BONUS_DAYS;
  const retention = Math.pow(0.5, daysSince / halfLife);

  // Scale by mastery: there's little to forget if mastery was never high to begin with.
  return clamp01((1 - retention) * mastery.overallMastery);
}

// ---------------------------------------------------------------------------
// Recency / interleaving (spec §14, §24)
// ---------------------------------------------------------------------------

/** Penalizes concepts practiced very recently, decaying to 0 across the window — discourages "Firewalls, Firewalls, Firewalls" (spec §14). */
export function calculateRecencyPenalty(conceptId: string, state: StudentLearningState): number {
  const index = state.recentlyPracticedConceptIds.indexOf(conceptId);
  if (index === -1 || index >= RECENCY_WINDOW_SIZE) return 0;
  return clamp01(RECENCY_MAX_PENALTY * (1 - index / RECENCY_WINDOW_SIZE));
}

// ---------------------------------------------------------------------------
// Goal relevance (spec §15-16)
// ---------------------------------------------------------------------------

function examUrgency(targetDate: Date, now: Date): number {
  const daysUntil = (targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (daysUntil <= EXAM_URGENCY_BANDS.veryHighWithinDays) return EXAM_URGENCY_SCORES.veryHigh;
  if (daysUntil <= EXAM_URGENCY_BANDS.highWithinDays) return EXAM_URGENCY_SCORES.high;
  if (daysUntil <= EXAM_URGENCY_BANDS.increasedWithinDays) return EXAM_URGENCY_SCORES.increased;
  return EXAM_URGENCY_SCORES.normal;
}

/** Urgency increases priority; it never overrides prerequisite ordering by itself (spec §16) — it's just one additive component of concept value. */
export function calculateGoalRelevanceScore(
  conceptId: string,
  state: StudentLearningState,
  now: Date = new Date(),
): number {
  if (state.goals.length === 0) return 0;

  let best = 0;
  for (const goal of state.goals) {
    const appliesToConcept =
      !goal.targetConceptIds || goal.targetConceptIds.length === 0 || goal.targetConceptIds.includes(conceptId);
    if (!appliesToConcept) continue;

    const score =
      goal.type === "EXAM" && goal.targetDate && goal.targetDate.getTime() >= now.getTime()
        ? examUrgency(goal.targetDate, now)
        : EXAM_URGENCY_SCORES.normal;

    best = Math.max(best, score);
  }
  return clamp01(best);
}

// ---------------------------------------------------------------------------
// Combined concept value (spec §17)
// ---------------------------------------------------------------------------

export interface ConceptValueBreakdown {
  conceptId: string;
  weakness: number;
  prerequisiteImportance: number;
  mistakeScore: number;
  forgettingRisk: number;
  goalRelevance: number;
  recencyPenalty: number;
  value: number;
  block: PrerequisiteBlockResult;
}

/** Weights sum to 1 so `value` naturally lands in [0,1] before the recency penalty is subtracted. */
const VALUE_WEIGHTS = {
  weakness: 0.35,
  prerequisiteImportance: 0.15,
  mistakeScore: 0.2,
  forgettingRisk: 0.15,
  goalRelevance: 0.15,
} as const;

export function calculateConceptValue(
  conceptId: string,
  state: StudentLearningState,
  now: Date = new Date(),
): ConceptValueBreakdown {
  const mastery = state.masteryByConceptId.get(conceptId);
  const weakness = calculateWeaknessScore(mastery);
  const prerequisiteImportance = calculatePrerequisiteImportance(conceptId, state);
  const mistakeScore = calculateRecentMistakeScore(conceptId, state, now);
  const forgettingRisk = calculateForgettingRiskScore(conceptId, state, now);
  const goalRelevance = calculateGoalRelevanceScore(conceptId, state, now);
  const recencyPenalty = calculateRecencyPenalty(conceptId, state);
  const block = findPrerequisiteBlock(conceptId, state);

  const rawValue =
    weakness * VALUE_WEIGHTS.weakness +
    prerequisiteImportance * VALUE_WEIGHTS.prerequisiteImportance +
    mistakeScore * VALUE_WEIGHTS.mistakeScore +
    forgettingRisk * VALUE_WEIGHTS.forgettingRisk +
    goalRelevance * VALUE_WEIGHTS.goalRelevance;

  return {
    conceptId,
    weakness,
    prerequisiteImportance,
    mistakeScore,
    forgettingRisk,
    goalRelevance,
    recencyPenalty,
    value: clamp01(rawValue - recencyPenalty),
    block,
  };
}
