import { decideNextAction, type DecisionInput, type DecisionResult, type SessionBookkeeping } from "./tutor-decision";
import type { TutorContext, TutorDecisionAction, TutorModeValue } from "./types";
import type { TurnEvaluation } from "./decision-support";

/**
 * TutorEngine (spec §2): the single public entry point that turns a
 * TutorContext + the current session's bookkeeping into a TutorDecision.
 * This is deliberately a thin bridge over tutor-decision.ts's
 * decideNextAction — the real branching logic lives there and in
 * socratic.ts / remediation.ts / teach-back.ts, kept out of this file so
 * "the engine" stays a short, readable dispatch point rather than the
 * "1000 lines of unexplained conditions" the spec explicitly warns against.
 */

export interface TutorSessionSnapshot {
  mode: TutorModeValue;
  socraticDepth: number;
  hintLevel: number;
  difficulty: number;
  consecutiveCorrect: number;
  consecutiveIncorrect: number;
  answerRevealed: boolean;
  lastExplanationStrategy: string | null;
  currentStep: TutorDecisionAction | null;
}

export interface TutorEngineInput {
  ctx: TutorContext;
  session: TutorSessionSnapshot;
  /** null only for the very first turn of a session (no student response yet). */
  turn: TurnEvaluation | null;
  explicitDontKnow: boolean;
  explicitRevealRequest: boolean;
}

function toBookkeeping(session: TutorSessionSnapshot): SessionBookkeeping {
  return {
    mode: session.mode,
    socraticDepth: session.socraticDepth,
    hintLevel: session.hintLevel,
    difficulty: session.difficulty,
    consecutiveCorrect: session.consecutiveCorrect,
    consecutiveIncorrect: session.consecutiveIncorrect,
    answerRevealed: session.answerRevealed,
    lastExplanationStrategy: session.lastExplanationStrategy,
    lastAction: session.currentStep,
  };
}

export const TutorEngine = {
  /** Given everything we know about this student's state and the latest turn, decide the single next pedagogically useful action. */
  decide(input: TutorEngineInput): DecisionResult {
    const decisionInput: DecisionInput = {
      ctx: input.ctx,
      bookkeeping: toBookkeeping(input.session),
      turn: input.turn,
      explicitDontKnow: input.explicitDontKnow,
      explicitRevealRequest: input.explicitRevealRequest,
    };
    return decideNextAction(decisionInput);
  },
};
