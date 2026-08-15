import { HINT_EVIDENCE_DISCOUNT } from "./config";
import type { HintLevelLabel } from "./types";

/**
 * Deterministic hint-level state machine (spec §22-24). Level selection
 * itself needs no Claude call (spec §53) — only the hint *text* at a given
 * level does (see tutor-evaluator.ts's generateHint).
 *
 * 0 = no hint requested yet on the current question.
 * 1-3 = HINT_1..HINT_3 (progressive, never skip ahead — spec §23).
 * 4 = REVEAL.
 */
export const NO_HINT = 0;
export const MAX_HINT_LEVEL = 4;

export function nextHintLevel(currentLevel: number): number {
  return Math.min(MAX_HINT_LEVEL, Math.max(NO_HINT, currentLevel) + 1);
}

export function hintLevelLabel(level: number): HintLevelLabel | null {
  switch (level) {
    case 1:
      return "HINT_1";
    case 2:
      return "HINT_2";
    case 3:
      return "HINT_3";
    case 4:
      return "REVEAL";
    default:
      return null;
  }
}

export function isReveal(level: number): boolean {
  return level >= MAX_HINT_LEVEL;
}

/**
 * Applies the hint-strength discount to a correct answer's raw score before
 * it reaches recordLearningOutcome() (spec §24): correct without a hint is
 * strong evidence (discount 1.0), and each escalating hint level weakens
 * it. A REVEAL (level 4) never calls this — it produces no evidence of its
 * own (spec §46), only the retrieval question that follows it does.
 */
export function applyHintDiscount(rawScore: number, hintLevel: number): number {
  if (hintLevel <= 0) return rawScore;
  const discount = HINT_EVIDENCE_DISCOUNT[hintLevel as 1 | 2 | 3] ?? HINT_EVIDENCE_DISCOUNT[3];
  return Math.min(1, Math.max(0, rawScore * discount));
}
