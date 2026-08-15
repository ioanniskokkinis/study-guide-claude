import { clampDifficulty } from "@/lib/learning/difficulty-engine";
import { COMPLETION_CORRECT_STREAK } from "./config";
import {
  buildDecision,
  pickExplanationStrategy,
  resetForModeTransition,
  type DecisionResult,
  type SessionBookkeeping,
} from "./decision-support";
import type { ResponseClassification, ResponseEvaluation, TutorContext } from "./types";

/**
 * Remediation mode's loop (spec §14-17): explain a small, targeted piece,
 * ask an easy retrieval question, evaluate, retry on failure with a
 * different explanation strategy, and only increase difficulty (exiting
 * back to Socratic practice) once the student has demonstrated two
 * independent correct answers. Never called for MISCONCEPTION — that's a
 * cross-cutting override in tutor-decision.ts.
 */
export function nextRemediationDecision(
  ctx: TutorContext,
  bookkeeping: SessionBookkeeping,
  evaluation: ResponseEvaluation,
  classification: ResponseClassification,
): DecisionResult {
  if (classification === "CORRECT") {
    const consecutiveCorrect = bookkeeping.consecutiveCorrect + 1;
    const independentCorrectEvidence = bookkeeping.hintLevel === 0;

    if (consecutiveCorrect >= COMPLETION_CORRECT_STREAK) {
      const difficulty = clampDifficulty(bookkeeping.difficulty + 1);
      return {
        decision: buildDecision({
          action: "INCREASE_DIFFICULTY",
          conceptId: ctx.conceptId,
          difficulty,
          reason: `Two solid independent answers on ${ctx.conceptName} — back to regular practice.`,
          messageType: "FEEDBACK",
          mode: "SOCRATIC",
        }),
        bookkeeping: { ...resetForModeTransition(bookkeeping, "SOCRATIC", "INCREASE_DIFFICULTY"), difficulty },
        misconceptionToRecord: null,
        independentCorrectEvidence,
      };
    }

    return {
      decision: buildDecision({
        action: "ASK_QUESTION",
        conceptId: ctx.conceptId,
        difficulty: bookkeeping.difficulty,
        reason: "Good — one more like that to be sure it's solid.",
        messageType: "QUESTION",
        mode: "REMEDIATION",
      }),
      bookkeeping: {
        ...bookkeeping,
        consecutiveCorrect,
        consecutiveIncorrect: 0,
        hintLevel: 0,
        lastAction: "ASK_QUESTION",
      },
      misconceptionToRecord: null,
      independentCorrectEvidence,
    };
  }

  // Not correct — go back to a small, targeted explanation with a different
  // strategy than last time (spec §16, §28), never a long one (spec §16).
  const consecutiveIncorrect = bookkeeping.consecutiveIncorrect + 1;
  const strategy = pickExplanationStrategy(bookkeeping.lastExplanationStrategy);

  return {
    decision: buildDecision({
      action: "GIVE_EXPLANATION",
      conceptId: ctx.conceptId,
      difficulty: Math.max(1, bookkeeping.difficulty - 1),
      reason: `Let's look at ${ctx.conceptName} a different way.`,
      messageType: "EXPLANATION",
      mode: "REMEDIATION",
      metadata: { explanationStrategy: strategy },
    }),
    bookkeeping: {
      ...bookkeeping,
      consecutiveCorrect: 0,
      consecutiveIncorrect,
      hintLevel: 0,
      lastExplanationStrategy: strategy,
      lastAction: "GIVE_EXPLANATION",
    },
    misconceptionToRecord: null,
    independentCorrectEvidence: false,
  };
}
