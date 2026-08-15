import { prisma } from "@/lib/db/prisma";
import { bucketForStatus, type MasteryBucket } from "@/lib/services/student-knowledge";
import { clampDifficulty, selectDifficultyForConcept } from "@/lib/learning/difficulty-engine";
import {
  calculateConceptValue,
  calculateRecencyPenalty,
  type ConceptValueBreakdown,
} from "./adaptive/concept-scoring";
import {
  buildCandidateContext,
  repeatedFailureScore,
  scoreActiveRecall,
  scoreChallenge,
  scorePrerequisiteReview,
  scoreRemediation,
  scoreReview,
  type CandidateContext,
} from "./adaptive/action-scoring";
import { getStudentLearningState, type StudentLearningState } from "./adaptive/student-state";
import {
  ESTIMATED_DURATION_MINUTES,
  MISTAKE_RELEVANCE_WINDOW_DAYS,
} from "./adaptive/config";
import {
  NextLearningActionSchema,
  type ActionQuestionType,
  type ActionType,
  type NextLearningAction,
  type Reason,
} from "./adaptive/types";

export type { ActionType, NextLearningAction, Reason } from "./adaptive/types";
export { NextLearningActionSchema } from "./adaptive/types";

export class NoConceptsAvailableError extends Error {
  constructor() {
    super("This course has no knowledge graph yet — build it before the adaptive engine can recommend anything.");
  }
}

// ---------------------------------------------------------------------------
// Composable pipeline (spec §47 — no black box). Each step is independently
// exported and independently testable; getNextLearningAction() at the
// bottom is just the sequence, not where the logic actually lives.
// ---------------------------------------------------------------------------

export { getStudentLearningState as getStudentState };

/** Every concept in the course is a candidate — Phase 6 doesn't pre-filter (spec §6 scores everything, then compares). */
export function getCandidateConcepts(state: StudentLearningState) {
  return state.concepts;
}

/** Runs calculateConceptValue() for every course concept (spec §6). */
export function calculateConceptScores(
  state: StudentLearningState,
  now: Date = new Date(),
): Map<string, ConceptValueBreakdown> {
  const scores = new Map<string, ConceptValueBreakdown>();
  for (const concept of getCandidateConcepts(state)) {
    scores.set(concept.id, calculateConceptValue(concept.id, state, now));
  }
  return scores;
}

interface Candidate {
  actionType: ActionType;
  /** The concept the resulting question should actually target. */
  conceptId: string;
  priority: number;
  reason: Reason;
  factors: string[];
}

function pct(mastery: number): string {
  return `${Math.round(mastery * 100)}%`;
}

function conceptName(state: StudentLearningState, conceptId: string): string {
  return state.concepts.find((c) => c.id === conceptId)?.name ?? "this concept";
}

function buildFactors(conceptId: string, value: ConceptValueBreakdown, state: StudentLearningState, now: Date): string[] {
  const factors: string[] = [];
  const mastery = state.masteryByConceptId.get(conceptId);

  if (value.block.blocked && value.block.blockingConceptName) {
    factors.push(`prerequisite for ${conceptName(state, conceptId)}`);
  }
  factors.push(`mastery: ${pct(mastery?.overallMastery ?? 0)}`);

  const recentMistakeCount = (state.recentMistakesByConceptId.get(conceptId) ?? []).filter((m) => {
    const ageDays = (now.getTime() - m.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays <= MISTAKE_RELEVANCE_WINDOW_DAYS;
  }).length;
  if (recentMistakeCount > 0) {
    factors.push(`${recentMistakeCount} recent mistake${recentMistakeCount === 1 ? "" : "s"}`);
  }

  if (value.goalRelevance >= 0.6) factors.push("exam relevance: high");
  else if (value.goalRelevance >= 0.35) factors.push("exam relevance: medium");

  if (value.forgettingRisk >= 0.4) factors.push("retention risk rising");

  return factors;
}

/**
 * For each concept, scores every action type and emits a candidate for
 * every one that scored above 0 (spec §18). A PREREQUISITE_REVIEW
 * candidate's `conceptId` is redirected to the blocking prerequisite, not
 * the concept that triggered it — that's the whole point of the action
 * (spec §9: "the next action should usually target Ports," not Firewalls).
 */
export function generateCandidateActions(
  state: StudentLearningState,
  scores: Map<string, ConceptValueBreakdown>,
  now: Date = new Date(),
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const concept of getCandidateConcepts(state)) {
    const value = scores.get(concept.id);
    if (!value) continue;
    const ctx: CandidateContext = buildCandidateContext(concept.id, value, state, now);

    const prerequisiteScore = scorePrerequisiteReview(ctx);
    if (prerequisiteScore > 0 && value.block.blockingConceptId) {
      const blockingId = value.block.blockingConceptId;
      const blockingName = value.block.blockingConceptName ?? "a prerequisite";
      candidates.push({
        actionType: "PREREQUISITE_REVIEW",
        conceptId: blockingId,
        priority: prerequisiteScore,
        reason: {
          type: "PREREQUISITE_GAP",
          message: `${blockingName} is a prerequisite for ${concept.name} and needs reinforcement.`,
        },
        factors: buildFactors(blockingId, scores.get(blockingId) ?? value, state, now),
      });
    }

    const remediationScore = scoreRemediation(ctx);
    if (remediationScore > 0) {
      const misconception = ctx.hasSevereMisconception;
      const failure = repeatedFailureScore(ctx.attempts);
      const reason: Reason = misconception
        ? { type: "MISCONCEPTION", message: `A recent answer on ${concept.name} suggested a misconception worth addressing.` }
        : failure >= 0.5
          ? { type: "REPEATED_FAILURE", message: `Recent attempts show difficulty with ${concept.name}.` }
          : { type: "RECENT_MISTAKE", message: `You made a recent mistake on ${concept.name} that hasn't been resolved.` };
      candidates.push({
        actionType: "REMEDIATION",
        conceptId: concept.id,
        priority: remediationScore,
        reason,
        factors: buildFactors(concept.id, value, state, now),
      });
    }

    const activeRecallScore = scoreActiveRecall(ctx);
    if (activeRecallScore > 0) {
      const reason: Reason =
        value.goalRelevance >= 0.6
          ? { type: "GOAL_RELEVANCE", message: `${concept.name} is relevant to your upcoming exam.` }
          : { type: "WEAKNESS", message: `${concept.name} needs reinforcement based on your current mastery.` };
      candidates.push({
        actionType: "ACTIVE_RECALL",
        conceptId: concept.id,
        priority: activeRecallScore,
        reason,
        factors: buildFactors(concept.id, value, state, now),
      });
    }

    const reviewScore = scoreReview(ctx);
    if (reviewScore > 0) {
      candidates.push({
        actionType: "REVIEW",
        conceptId: concept.id,
        priority: reviewScore,
        reason: {
          type: "FORGETTING_RISK",
          message: `You haven't reviewed ${concept.name} recently and retention risk is increasing.`,
        },
        factors: buildFactors(concept.id, value, state, now),
      });
    }

    const challengeScore = scoreChallenge(ctx);
    if (challengeScore > 0) {
      candidates.push({
        actionType: "CHALLENGE",
        conceptId: concept.id,
        priority: challengeScore,
        reason: {
          type: "SUCCESS_STREAK",
          message: `You've performed well on ${concept.name}, so we're increasing the difficulty.`,
        },
        factors: buildFactors(concept.id, value, state, now),
      });
    }
  }

  return candidates;
}

/**
 * Highest priority wins; ties are broken by a small interleaving nudge so
 * a just-practiced concept doesn't immediately win a dead heat again (spec
 * §14/§24) — small enough to never flip a genuinely more urgent action.
 */
export function rankActions(candidates: Candidate[], state: StudentLearningState): Candidate | null {
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestScore = best.priority - calculateRecencyPenalty(best.conceptId, state) * 0.1;

  for (const candidate of candidates.slice(1)) {
    const score = candidate.priority - calculateRecencyPenalty(candidate.conceptId, state) * 0.1;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

/** No candidates carry more explanation than their embedded `reason`/`factors` — this just exists as its own named step per spec §47. */
export function explainDecision(candidate: Candidate): { reason: Reason; factors: string[] } {
  return { reason: candidate.reason, factors: candidate.factors };
}

function questionTypeForAction(actionType: ActionType, bucket: MasteryBucket): ActionQuestionType {
  if (actionType === "CHALLENGE") return "APPLY";
  if (actionType === "REMEDIATION" || actionType === "PREREQUISITE_REVIEW" || actionType === "REVIEW") return "RECALL";
  // ACTIVE_RECALL and REST fall back to the concept's own bucket.
  switch (bucket) {
    case "unknown":
    case "weak":
      return "RECALL";
    case "developing":
      return "EXPLAIN";
    case "strong":
      return "APPLY";
  }
}

async function difficultyForAction(
  userId: string,
  actionType: ActionType,
  conceptId: string,
  baseDifficulty: number,
): Promise<number> {
  const adaptive = await selectDifficultyForConcept(userId, conceptId, baseDifficulty);
  switch (actionType) {
    case "REMEDIATION":
      return clampDifficulty(adaptive - 1);
    case "PREREQUISITE_REVIEW":
      return clampDifficulty(Math.min(adaptive, 2));
    case "CHALLENGE":
      return clampDifficulty(adaptive + 1);
    default:
      return adaptive;
  }
}

async function toNextLearningAction(
  candidate: Candidate,
  state: StudentLearningState,
  userId: string,
): Promise<NextLearningAction> {
  const concept = state.concepts.find((c) => c.id === candidate.conceptId);
  const mastery = state.masteryByConceptId.get(candidate.conceptId);
  const bucket = bucketForStatus(mastery?.status ?? "UNKNOWN");
  const { reason, factors } = explainDecision(candidate);

  const difficulty = await difficultyForAction(userId, candidate.actionType, candidate.conceptId, concept?.difficulty ?? 2);

  const action: NextLearningAction = {
    actionType: candidate.actionType,
    conceptId: candidate.conceptId,
    conceptName: concept?.name ?? conceptName(state, candidate.conceptId),
    priority: candidate.priority,
    difficulty,
    suggestedQuestionType: questionTypeForAction(candidate.actionType, bucket),
    reason,
    factors,
    estimatedDurationMinutes: ESTIMATED_DURATION_MINUTES[candidate.actionType] ?? 5,
  };

  return NextLearningActionSchema.parse(action);
}

/** No prerequisites at all — a reasonable "start here" pick for a student with zero history (spec §50). */
function isFoundational(conceptId: string, state: StudentLearningState): boolean {
  return (state.prerequisitesByTarget.get(conceptId) ?? []).length === 0;
}

async function logDecision(params: {
  userId: string;
  courseId: string;
  action: NextLearningAction;
}): Promise<string> {
  const log = await prisma.adaptiveDecisionLog.create({
    data: {
      userId: params.userId,
      courseId: params.courseId,
      conceptId: params.action.conceptId,
      actionType: params.action.actionType,
      priority: params.action.priority,
      reasonType: params.action.reason.type,
      reasonMessage: params.action.reason.message,
    },
  });
  return log.id;
}

export interface NextLearningActionResult {
  action: NextLearningAction;
  decisionLogId: string;
}

/**
 * The single entry point (spec §26): "given everything we know about this
 * student, what's the highest-value action?" Fully deterministic — zero
 * Claude calls (spec §41-42) — everything comes from PostgreSQL via
 * getStudentLearningState() and the scoring functions in concept-scoring.ts
 * / action-scoring.ts. Every call is logged to AdaptiveDecisionLog (spec
 * §43-44), including internal continuations from within an Active Recall
 * session — `accepted` stays null for those; only genuine dashboard-level
 * recommendation moments set it (see learning-goals/dashboard routes).
 *
 * Throws NoConceptsAvailableError if the course has no knowledge graph yet
 * — there is nothing to recommend. Never throws for "student has no
 * history yet"; that's handled as a first-class case (spec §50) by
 * preferring a foundational (no-prerequisite) concept.
 */
export async function getNextLearningAction(params: {
  userId: string;
  courseId: string;
}): Promise<NextLearningActionResult> {
  const now = new Date();
  const state = await getStudentLearningState(params.userId, params.courseId);
  if (!state || state.concepts.length === 0) throw new NoConceptsAvailableError();

  const scores = calculateConceptScores(state, now);
  const candidates = generateCandidateActions(state, scores, now);

  let best = rankActions(candidates, state);
  if (!best) throw new NoConceptsAvailableError();

  // Never-studied student: prefer a foundational concept among near-top candidates rather than an arbitrary one.
  if (state.lastActivityAt === null && best.actionType === "ACTIVE_RECALL") {
    const nearTop = candidates.filter((c) => c.actionType === "ACTIVE_RECALL" && best!.priority - c.priority <= 0.05);
    const foundational = nearTop.find((c) => isFoundational(c.conceptId, state));
    if (foundational && foundational.conceptId !== best.conceptId) {
      best = {
        ...foundational,
        reason: { type: "NO_DATA", message: `Start with the fundamentals — ${conceptName(state, foundational.conceptId)} has no prerequisites.` },
      };
    } else if (foundational) {
      best = { ...best, reason: { type: "NO_DATA", message: `Start with the fundamentals — ${best.reason.message}` } };
    }
  }

  const action = await toNextLearningAction(best, state, params.userId);
  const decisionLogId = await logDecision({ userId: params.userId, courseId: params.courseId, action });

  return { action, decisionLogId };
}

/** Marks a genuine dashboard-level recommendation as accepted/overridden (spec §30-31). Returns null if not found/owned. */
export async function recordDecisionResponse(
  decisionLogId: string,
  userId: string,
  accepted: boolean,
): Promise<boolean> {
  const result = await prisma.adaptiveDecisionLog.updateMany({
    where: { id: decisionLogId, userId },
    data: { accepted },
  });
  return result.count > 0;
}
