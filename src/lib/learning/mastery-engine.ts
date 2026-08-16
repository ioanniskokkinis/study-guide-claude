import type { EvidenceOutcome, LearningActivityType, MasteryStatus, Prisma, StudentConceptMastery } from "@/generated/prisma/client";

/**
 * Deterministic mastery calculation (spec §28: never call Claude to compute
 * mastery — an AI evaluation, when one exists in a later phase, is just
 * another `score`/`outcome` input here, same as everything else).
 */

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export type MasteryDimension = "recall" | "explanation" | "application" | "transfer";

/**
 * Which of the four tracked dimensions a given activity provides evidence
 * for. Kept intentionally coarse (one dimension per attempt) — Phase 4's
 * algorithm is a simple weighted average, not a multi-output model.
 */
export function mapActivityToDimension(activityType: LearningActivityType): MasteryDimension {
  switch (activityType) {
    case "RECALL":
    case "DIAGNOSTIC":
      return "recall";
    case "EXPLANATION":
    case "TEACH_BACK":
      return "explanation";
    case "APPLICATION":
    case "SCENARIO":
    case "EXAM":
      return "application";
    case "TRANSFER":
      return "transfer";
  }
}

/** Overall mastery weights (spec §11) — application counts more than raw recall. */
export const DIMENSION_WEIGHTS = {
  recall: 0.2,
  explanation: 0.25,
  application: 0.3,
  transfer: 0.25,
} as const;

/** Score interpretation bands (spec §10). */
export const MASTERY_THRESHOLDS = {
  weak: 0.3,
  developing: 0.5,
  strong: 0.7,
  masteryCandidate: 0.85,
} as const;

/** "One lucky correct answer != mastery" (spec §10) — require attempt-count evidence too. */
export const MIN_SUCCESSFUL_ATTEMPTS_FOR_MASTERY = 3;

/** Below this many attempts, a low score is just "still learning," not "struggling enough to flag." */
export const STRUGGLE_ATTEMPT_THRESHOLD_FOR_REMEDIATION = 3;

export interface DimensionScores {
  recallScore: number;
  explanationScore: number;
  applicationScore: number;
  transferScore: number;
}

export function computeOverallMastery(scores: DimensionScores): number {
  return clamp01(
    scores.recallScore * DIMENSION_WEIGHTS.recall +
      scores.explanationScore * DIMENSION_WEIGHTS.explanation +
      scores.applicationScore * DIMENSION_WEIGHTS.application +
      scores.transferScore * DIMENSION_WEIGHTS.transfer,
  );
}

/**
 * Never collapse to a boolean (spec §1). UNKNOWN means "not enough evidence
 * yet," not "student doesn't know this" — it is the default for a concept
 * with zero exposure and must never be presented to the student as a
 * negative signal (spec §32).
 */
export function deriveStatus(
  overallMastery: number,
  attemptCount: number,
  successCount: number,
  exposureCount: number,
): MasteryStatus {
  if (exposureCount === 0) return "UNKNOWN";

  if (overallMastery >= MASTERY_THRESHOLDS.masteryCandidate && successCount >= MIN_SUCCESSFUL_ATTEMPTS_FOR_MASTERY) {
    return "MASTERED";
  }
  if (overallMastery < MASTERY_THRESHOLDS.weak && attemptCount >= STRUGGLE_ATTEMPT_THRESHOLD_FOR_REMEDIATION) {
    return "NEEDS_REMEDIATION";
  }
  if (overallMastery >= MASTERY_THRESHOLDS.strong) return "STRONG";
  if (overallMastery >= MASTERY_THRESHOLDS.developing) return "DEVELOPING";
  return "LEARNING";
}

/** Converts a raw 0-1 score into a discrete outcome, for callers that don't already have one. */
export function deriveOutcomeFromScore(score: number): EvidenceOutcome {
  if (score >= 0.7) return "SUCCESS";
  if (score >= 0.4) return "PARTIAL";
  return "FAILURE";
}

/**
 * Pluggable update rule (spec §9) so the deterministic weighted-average
 * approach used now can later be swapped for a Bayesian or FSRS-inspired
 * strategy without touching callers.
 */
export interface MasteryStrategy {
  nextScore(oldScore: number, exposureCount: number, newEvidenceScore: number): number;
}

/**
 * newScore = oldScore * (1 - evidenceWeight) + newEvidence * evidenceWeight.
 * Recency-weighted by construction: every new observation counts for a
 * fixed fraction of the result regardless of how much history exists, so a
 * long-ago data point's influence decays geometrically with each
 * subsequent update (an EMA), rather than being averaged in with equal
 * weight forever.
 */
export class WeightedEvidenceStrategy implements MasteryStrategy {
  constructor(private readonly evidenceWeight = 0.35) {}

  nextScore(oldScore: number, exposureCount: number, newEvidenceScore: number): number {
    if (exposureCount === 0) return clamp01(newEvidenceScore);
    return clamp01(oldScore * (1 - this.evidenceWeight) + newEvidenceScore * this.evidenceWeight);
  }
}

/** The base recency weight every single piece of evidence gets before any streak/difficulty adjustment (Phase 2 §B). */
export const BASE_EVIDENCE_WEIGHT = 0.35;
/** Hard ceiling on the adjusted weight — however strong the streak/difficulty signal, one answer can never swing mastery unrealistically (Phase 2 §B). */
export const MAX_EVIDENCE_WEIGHT = 0.6;
/** Per consecutive same-direction outcome, capped so a long streak still can't dominate a single update. */
const STREAK_WEIGHT_STEP = 0.03;
const STREAK_WEIGHT_CAP = 0.15;
/** How much a question's difficulty (1-5) can shift the weight: a correct answer on a hard question counts more; a wrong answer on a hard question is less damning than the same miss on an easy one. */
const DIFFICULTY_CORRECT_BONUS = 0.1;
const DIFFICULTY_INCORRECT_RELIEF = 0.05;

/**
 * Streak/difficulty-aware evidence weight (Phase 2 §B: "repeated incorrect
 * answers: stronger signal," "repeated correct answers: gradual increase,"
 * "do not allow one answer to cause an unrealistic mastery jump"). Purely a
 * function of state already on hand — no DB access, deterministic.
 * `streakBeforeThisEvidence` is signed: positive = consecutive successes,
 * negative = consecutive failures, 0 = no streak (or the last outcome was
 * PARTIAL, which breaks a streak in either direction).
 */
export function computeEvidenceWeight(
  streakBeforeThisEvidence: number,
  difficulty: number | null | undefined,
  outcome: EvidenceOutcome,
  baseWeight: number = BASE_EVIDENCE_WEIGHT,
): number {
  let weight = baseWeight;

  const sameDirection =
    (outcome === "SUCCESS" && streakBeforeThisEvidence > 0) || (outcome === "FAILURE" && streakBeforeThisEvidence < 0);
  if (sameDirection) {
    weight += Math.min(Math.abs(streakBeforeThisEvidence) * STREAK_WEIGHT_STEP, STREAK_WEIGHT_CAP);
  }

  if (difficulty != null) {
    const normalizedDifficulty = clamp01((difficulty - 1) / 4); // 1..5 -> 0..1
    if (outcome === "SUCCESS") weight += normalizedDifficulty * DIFFICULTY_CORRECT_BONUS;
    else if (outcome === "FAILURE") weight += (1 - normalizedDifficulty) * DIFFICULTY_INCORRECT_RELIEF;
  }

  return Math.min(weight, MAX_EVIDENCE_WEIGHT);
}

/** Next signed streak value after one piece of evidence — PARTIAL always resets to 0 (spec: neither a clean win nor a clean loss). */
export function nextStreak(currentStreak: number, outcome: EvidenceOutcome): number {
  if (outcome === "SUCCESS") return currentStreak >= 0 ? currentStreak + 1 : 1;
  if (outcome === "FAILURE") return currentStreak <= 0 ? currentStreak - 1 : -1;
  return 0;
}

export interface MasterySnapshot extends DimensionScores {
  confidenceScore: number;
  overallMastery: number;
  exposureCount: number;
  attemptCount: number;
  successCount: number;
  failureCount: number;
  hintCount: number;
  revealCount: number;
  status: MasteryStatus;
  /** Signed: positive = consecutive correct, negative = consecutive incorrect, 0 = none/broken by a PARTIAL. */
  currentStreak: number;
  /** Best (highest) consecutive-correct streak ever reached — never decreases. */
  bestStreak: number;
}

export function emptyMasterySnapshot(): MasterySnapshot {
  return {
    recallScore: 0,
    explanationScore: 0,
    applicationScore: 0,
    transferScore: 0,
    confidenceScore: 0,
    overallMastery: 0,
    exposureCount: 0,
    attemptCount: 0,
    successCount: 0,
    failureCount: 0,
    hintCount: 0,
    revealCount: 0,
    status: "UNKNOWN",
    currentStreak: 0,
    bestStreak: 0,
  };
}

export interface EvidenceInput {
  activityType: LearningActivityType;
  /** 0-1 dimension-level score this attempt provides. */
  score: number;
  outcome: EvidenceOutcome;
  /** 0-1 normalized self-reported confidence, or null/undefined if not collected. */
  confidence?: number | null;
  usedHint?: boolean;
  revealedAnswer?: boolean;
  /** 1-5, same scale as Concept/Question/ExamQuestion/ReviewItem difficulty — modulates the evidence weight (Phase 2 §B). */
  difficulty?: number | null;
}

/**
 * Pure state-transition function: current mastery + one new piece of
 * evidence -> next mastery. No DB access, no side effects — this is what
 * every unit test in the mastery test suite exercises directly. When no
 * explicit `strategy` is given, the evidence weight is derived from the
 * student's current streak and this evidence's difficulty (still bounded —
 * see MAX_EVIDENCE_WEIGHT) rather than a single fixed constant.
 */
export function applyEvidence(current: MasterySnapshot, evidence: EvidenceInput, strategy?: MasteryStrategy): MasterySnapshot {
  const dimension = mapActivityToDimension(evidence.activityType);
  const dimensionKey = `${dimension}Score` as const;
  const effectiveStrategy =
    strategy ?? new WeightedEvidenceStrategy(computeEvidenceWeight(current.currentStreak, evidence.difficulty, evidence.outcome));

  // exposureCount is a single counter shared across all four dimensions, but
  // each dimension's own history should only "count" once evidence has
  // actually touched *that* dimension — otherwise a concept's first-ever
  // explanation score would get diluted by unrelated recall history just
  // because exposureCount was already > 0. A dimension score of exactly 0 is
  // effectively unambiguous with "never observed" (real evidence scores are
  // continuous and essentially never land on exact 0), so it doubles as the
  // per-dimension "first touch" signal without a schema change.
  const dimensionExposure = current[dimensionKey] === 0 ? 0 : current.exposureCount;
  const next: MasterySnapshot = {
    ...current,
    [dimensionKey]: effectiveStrategy.nextScore(current[dimensionKey], dimensionExposure, clamp01(evidence.score)),
  };

  if (evidence.confidence != null) {
    const confidenceExposure = current.confidenceScore === 0 ? 0 : current.exposureCount;
    next.confidenceScore = effectiveStrategy.nextScore(current.confidenceScore, confidenceExposure, clamp01(evidence.confidence));
  }

  next.exposureCount = current.exposureCount + 1;
  next.attemptCount = current.attemptCount + 1;
  if (evidence.outcome === "SUCCESS") next.successCount = current.successCount + 1;
  if (evidence.outcome === "FAILURE") next.failureCount = current.failureCount + 1;
  if (evidence.usedHint) next.hintCount = current.hintCount + 1;
  if (evidence.revealedAnswer) next.revealCount = current.revealCount + 1;

  next.currentStreak = nextStreak(current.currentStreak, evidence.outcome);
  next.bestStreak = Math.max(current.bestStreak, next.currentStreak);

  next.overallMastery = computeOverallMastery(next);
  next.status = deriveStatus(next.overallMastery, next.attemptCount, next.successCount, next.exposureCount);

  return next;
}

/**
 * DB-aware wrapper around `applyEvidence`: loads (or lazily creates — spec
 * §3, never pre-populate) the student's mastery row for this concept,
 * applies one piece of evidence, and writes the result back. Must be called
 * inside the same transaction as the LearningAttempt/KnowledgeEvidence
 * writes it's derived from (see record-outcome.ts).
 */
export async function updateMastery(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    conceptId: string;
    evidence: EvidenceInput;
    now?: Date;
  },
): Promise<StudentConceptMastery> {
  const now = params.now ?? new Date();

  const existing = await tx.studentConceptMastery.findUnique({
    where: { userId_conceptId: { userId: params.userId, conceptId: params.conceptId } },
  });

  const current: MasterySnapshot = existing ?? emptyMasterySnapshot();
  const next = applyEvidence(current, params.evidence);

  const timestamps = {
    lastAttemptAt: now,
    lastSuccessAt: params.evidence.outcome === "SUCCESS" ? now : (existing?.lastSuccessAt ?? null),
    lastFailureAt: params.evidence.outcome === "FAILURE" ? now : (existing?.lastFailureAt ?? null),
  };

  return tx.studentConceptMastery.upsert({
    where: { userId_conceptId: { userId: params.userId, conceptId: params.conceptId } },
    create: { userId: params.userId, conceptId: params.conceptId, ...next, ...timestamps },
    update: { ...next, ...timestamps },
  });
}
