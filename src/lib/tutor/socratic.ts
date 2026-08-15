import { clampDifficulty } from "@/lib/learning/difficulty-engine";
import { MAX_SOCRATIC_DEPTH, REPEATED_FAILURE_THRESHOLD } from "./config";
import { nextHintLevel } from "./hints";
import {
  buildDecision,
  pickExplanationStrategy,
  resetForModeTransition,
  type DecisionResult,
  type SessionBookkeeping,
} from "./decision-support";
import type { ConfidenceLevel, ResponseClassification, ResponseEvaluation, TutorContext, TutorDecisionAction } from "./types";

/**
 * Socratic mode's own progression rule (spec §7-10, §25): help the student
 * reach the answer without giving it away, one question at a time,
 * escalating through progressively stronger hints before falling back to a
 * direct explanation — and hand off to REMEDIATION on repeated failure.
 * Never called for a MISCONCEPTION classification — that's resolved as a
 * cross-cutting override in tutor-decision.ts before this runs.
 */
export function nextSocraticDecision(
  ctx: TutorContext,
  bookkeeping: SessionBookkeeping,
  evaluation: ResponseEvaluation,
  classification: ResponseClassification,
  selfReportedConfidence: ConfidenceLevel | null = null,
): DecisionResult {
  if (classification === "CORRECT") {
    return correctDecision(ctx, bookkeeping, selfReportedConfidence);
  }

  const consecutiveIncorrect = bookkeeping.consecutiveIncorrect + 1;

  if (consecutiveIncorrect >= REPEATED_FAILURE_THRESHOLD) {
    return {
      decision: buildDecision({
        action: "REMEDIATE",
        conceptId: ctx.conceptId,
        difficulty: Math.max(1, bookkeeping.difficulty - 1),
        reason: `A few attempts on ${ctx.conceptName} haven't landed — let's rebuild it step by step.`,
        messageType: "REMEDIATION",
        mode: "REMEDIATION",
      }),
      bookkeeping: resetForModeTransition(bookkeeping, "REMEDIATION", "REMEDIATE"),
      misconceptionToRecord: null,
      independentCorrectEvidence: false,
    };
  }

  if (classification === "PARTIALLY_CORRECT") {
    return {
      decision: buildDecision({
        action: "ASK_FOLLOWUP",
        conceptId: ctx.conceptId,
        difficulty: bookkeeping.difficulty,
        reason: "You're partly there — let's narrow in on the rest.",
        messageType: "FOLLOWUP",
        mode: "SOCRATIC",
      }),
      bookkeeping: {
        ...bookkeeping,
        socraticDepth: Math.min(MAX_SOCRATIC_DEPTH, bookkeeping.socraticDepth + 1),
        consecutiveCorrect: 0,
        consecutiveIncorrect,
        lastAction: "ASK_FOLLOWUP",
      },
      misconceptionToRecord: null,
      independentCorrectEvidence: false,
    };
  }

  // INCORRECT or UNKNOWN — escalate the Socratic ladder (spec §9, §25): a
  // simplified restatement first, then progressively stronger hints, then a
  // direct explanation once depth is exhausted.
  return incorrectDecision(ctx, bookkeeping, consecutiveIncorrect);
}

function correctDecision(
  ctx: TutorContext,
  bookkeeping: SessionBookkeeping,
  selfReportedConfidence: ConfidenceLevel | null,
): DecisionResult {
  const consecutiveCorrect = bookkeeping.consecutiveCorrect + 1;
  const independentCorrectEvidence = bookkeeping.hintLevel === 0;
  const baseBookkeeping: SessionBookkeeping = {
    ...bookkeeping,
    socraticDepth: 0,
    hintLevel: 0,
    consecutiveCorrect,
    consecutiveIncorrect: 0,
    answerRevealed: false,
  };

  // A genuine streak at high mastery earns a transfer-level question (spec §25 "strong teach-back -> challenge", applied here to Socratic streaks).
  if (ctx.masteryBucket === "strong" && consecutiveCorrect >= 2) {
    const difficulty = clampDifficulty(bookkeeping.difficulty + 1);
    return {
      decision: buildDecision({
        action: "DEEPEN",
        conceptId: ctx.conceptId,
        difficulty,
        reason: `You're handling ${ctx.conceptName} well — let's go a level deeper.`,
        messageType: "FOLLOWUP",
        mode: "SOCRATIC",
      }),
      bookkeeping: { ...baseBookkeeping, difficulty, lastAction: "DEEPEN" },
      misconceptionToRecord: null,
      independentCorrectEvidence,
    };
  }

  // Correct + confident -> increase difficulty (spec §25).
  if (selfReportedConfidence === "CONFIDENT") {
    const difficulty = clampDifficulty(bookkeeping.difficulty + 1);
    return {
      decision: buildDecision({
        action: "INCREASE_DIFFICULTY",
        conceptId: ctx.conceptId,
        difficulty,
        reason: `Confident and correct on ${ctx.conceptName} — raising the difficulty.`,
        messageType: "QUESTION",
        mode: "SOCRATIC",
      }),
      bookkeeping: { ...baseBookkeeping, difficulty, lastAction: "INCREASE_DIFFICULTY" },
      misconceptionToRecord: null,
      independentCorrectEvidence,
    };
  }

  // Correct + uncertain (or no self-report) -> follow-up (spec §25).
  return {
    decision: buildDecision({
      action: "ASK_FOLLOWUP",
      conceptId: ctx.conceptId,
      difficulty: bookkeeping.difficulty,
      reason: "Good — let's build on that.",
      messageType: "FOLLOWUP",
      mode: "SOCRATIC",
    }),
    bookkeeping: { ...baseBookkeeping, lastAction: "ASK_FOLLOWUP" },
    misconceptionToRecord: null,
    independentCorrectEvidence,
  };
}

function incorrectDecision(ctx: TutorContext, bookkeeping: SessionBookkeeping, consecutiveIncorrect: number): DecisionResult {
  const depth = bookkeeping.socraticDepth + 1;

  if (depth > MAX_SOCRATIC_DEPTH) {
    const strategy = pickExplanationStrategy(bookkeeping.lastExplanationStrategy);
    return {
      decision: buildDecision({
        action: "GIVE_EXPLANATION",
        conceptId: ctx.conceptId,
        difficulty: bookkeeping.difficulty,
        reason: `Let's walk through ${ctx.conceptName} directly.`,
        messageType: "EXPLANATION",
        mode: "SOCRATIC",
        metadata: { explanationStrategy: strategy },
      }),
      bookkeeping: {
        ...bookkeeping,
        socraticDepth: 0,
        hintLevel: 0,
        consecutiveIncorrect,
        lastExplanationStrategy: strategy,
        lastAction: "GIVE_EXPLANATION",
      },
      misconceptionToRecord: null,
      independentCorrectEvidence: false,
    };
  }

  // First miss on this question -> simplify (spec §25) rather than jumping straight to a hint.
  if (depth === 1) {
    return {
      decision: buildDecision({
        action: "SIMPLIFY",
        conceptId: ctx.conceptId,
        difficulty: Math.max(1, bookkeeping.difficulty - 1),
        reason: "Let's break that into a smaller step.",
        messageType: "FOLLOWUP",
        mode: "SOCRATIC",
      }),
      bookkeeping: { ...bookkeeping, socraticDepth: depth, consecutiveCorrect: 0, consecutiveIncorrect, lastAction: "SIMPLIFY" },
      misconceptionToRecord: null,
      independentCorrectEvidence: false,
    };
  }

  const giveHint = bookkeeping.hintLevel < 3;
  const action: TutorDecisionAction = giveHint ? "GIVE_HINT" : "ASK_FOLLOWUP";
  return {
    decision: buildDecision({
      action,
      conceptId: ctx.conceptId,
      difficulty: bookkeeping.difficulty,
      reason: giveHint ? "A nudge in the right direction." : "Let's approach this from another angle.",
      messageType: giveHint ? "HINT" : "FOLLOWUP",
      mode: "SOCRATIC",
    }),
    bookkeeping: {
      ...bookkeeping,
      socraticDepth: depth,
      hintLevel: giveHint ? nextHintLevel(bookkeeping.hintLevel) : bookkeeping.hintLevel,
      consecutiveCorrect: 0,
      consecutiveIncorrect,
      lastAction: action,
    },
    misconceptionToRecord: null,
    independentCorrectEvidence: false,
  };
}
