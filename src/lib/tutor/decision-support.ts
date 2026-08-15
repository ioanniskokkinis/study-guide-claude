import { clampDifficulty } from "@/lib/learning/difficulty-engine";
import {
  EXPLANATION_STRATEGIES,
  TutorDecisionSchema,
  type ConfidenceLevel,
  type ExplanationStrategy,
  type ResponseEvaluation,
  type TeachBackEvaluation,
  type TutorDecision,
  type TutorDecisionAction,
  type TutorMessageTypeValue,
  type TutorModeValue,
} from "./types";

/**
 * Types and pure helpers shared by tutor-decision.ts and the three mode
 * files (socratic.ts / remediation.ts / teach-back.ts). Split into its own
 * module — with no dependency on any of them — so those four files can
 * depend on this one without a circular import between the dispatcher and
 * the modes it dispatches to.
 */

export interface SessionBookkeeping {
  mode: TutorModeValue;
  socraticDepth: number;
  hintLevel: number;
  difficulty: number;
  consecutiveCorrect: number;
  consecutiveIncorrect: number;
  answerRevealed: boolean;
  lastExplanationStrategy: string | null;
  lastAction: TutorDecisionAction | null;
}

export type TurnEvaluation =
  | { kind: "response"; data: ResponseEvaluation; selfReportedConfidence: ConfidenceLevel | null }
  | { kind: "teachback"; data: TeachBackEvaluation };

export interface DecisionResult {
  decision: TutorDecision;
  bookkeeping: SessionBookkeeping;
  /** Set when this turn's classification/severity should be persisted as a StudentMisconception (spec §12). */
  misconceptionToRecord: { description: string; severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" } | null;
  /** True when this turn is independent, non-hinted, non-revealed correct evidence — feeds misconception resolution (spec §13) and completion (spec §49). */
  independentCorrectEvidence: boolean;
}

export function buildDecision(params: {
  action: TutorDecisionAction;
  conceptId: string;
  difficulty: number;
  reason: string;
  messageType: TutorMessageTypeValue;
  mode: TutorModeValue;
  metadata?: Record<string, string | number | boolean | null>;
}): TutorDecision {
  return TutorDecisionSchema.parse({
    action: params.action,
    conceptId: params.conceptId,
    difficulty: clampDifficulty(params.difficulty),
    reason: params.reason,
    messageType: params.messageType,
    mode: params.mode,
    metadata: params.metadata ?? {},
  });
}

export function resetForModeTransition(
  bookkeeping: SessionBookkeeping,
  mode: TutorModeValue,
  lastAction: TutorDecisionAction,
): SessionBookkeeping {
  return {
    ...bookkeeping,
    mode,
    socraticDepth: 0,
    hintLevel: 0,
    consecutiveCorrect: 0,
    consecutiveIncorrect: 0,
    answerRevealed: false,
    lastAction,
  };
}

/**
 * Deterministically picks the next explanation strategy, guaranteed never
 * to repeat the immediately-previous one (spec §28) — no randomness needed,
 * just the first candidate in a fixed rotation that isn't `lastStrategy`.
 */
export function pickExplanationStrategy(lastStrategy: string | null): ExplanationStrategy {
  return EXPLANATION_STRATEGIES.find((s) => s !== lastStrategy) ?? EXPLANATION_STRATEGIES[0];
}

export function noMetadata(): Record<string, string | number | boolean | null> {
  return {};
}

export const CONTINUATION_ACTIONS: TutorDecisionAction[] = ["ASK_FOLLOWUP", "ASK_QUESTION", "INCREASE_DIFFICULTY", "DEEPEN"];
