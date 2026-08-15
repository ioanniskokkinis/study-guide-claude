import { clampDifficulty } from "@/lib/learning/difficulty-engine";
import { clamp01 } from "@/lib/learning/mastery-engine";
import { TEACH_BACK_BAND_FOLLOWUP, TEACH_BACK_BAND_REMEDIATION, TEACH_BACK_BAND_STRONG, TEACH_BACK_WEIGHTS } from "./config";
import { buildDecision, resetForModeTransition, type DecisionResult, type SessionBookkeeping } from "./decision-support";
import type { TeachBackEvaluation, TutorContext } from "./types";

/**
 * Combines a TeachBackEvaluation's dimensions into a single 0-1 score (spec
 * §20) — each misconception found costs a third of the misconception
 * weight, so a couple of small slips don't fully zero out an otherwise
 * strong explanation the way a hard misconceptionPenalty gate would.
 */
export function scoreTeachBack(evaluation: TeachBackEvaluation): number {
  const misconceptionComponent = Math.max(0, 1 - evaluation.misconceptions.length / 3);
  return clamp01(
    evaluation.correctness * TEACH_BACK_WEIGHTS.correctness +
      evaluation.completeness * TEACH_BACK_WEIGHTS.completeness +
      evaluation.conceptualAccuracy * TEACH_BACK_WEIGHTS.conceptualAccuracy +
      misconceptionComponent * TEACH_BACK_WEIGHTS.misconceptionPenalty,
  );
}

/**
 * Teach-back mode's adaptation rule (spec §18-21): score the explanation,
 * then band it into the next action. A strong explanation earns a transfer
 * question at higher difficulty; a poor one (or one with a real prerequisite
 * gap behind it) routes back through remediation or the adaptive engine's
 * own prerequisite-blocking signal — never duplicated here (spec §17, §40).
 */
export function nextTeachBackDecision(
  ctx: TutorContext,
  bookkeeping: SessionBookkeeping,
  evaluation: TeachBackEvaluation,
): DecisionResult {
  const score = scoreTeachBack(evaluation);
  const misconceptionToRecord =
    evaluation.misconceptions.length > 0 ? { description: evaluation.misconceptions[0], severity: "MEDIUM" as const } : null;

  if (score >= TEACH_BACK_BAND_STRONG) {
    const difficulty = clampDifficulty(bookkeeping.difficulty + 1);
    return {
      decision: buildDecision({
        action: "DEEPEN",
        conceptId: ctx.conceptId,
        difficulty,
        reason: `Strong teach-back on ${ctx.conceptName} — let's push into a transfer question.`,
        messageType: "FOLLOWUP",
        mode: "SOCRATIC",
      }),
      bookkeeping: {
        ...resetForModeTransition(bookkeeping, "SOCRATIC", "DEEPEN"),
        difficulty,
        consecutiveCorrect: bookkeeping.consecutiveCorrect + (misconceptionToRecord ? 0 : 1),
      },
      misconceptionToRecord,
      independentCorrectEvidence: misconceptionToRecord === null,
    };
  }

  if (score >= TEACH_BACK_BAND_FOLLOWUP) {
    return {
      decision: buildDecision({
        action: "ASK_FOLLOWUP",
        conceptId: ctx.conceptId,
        difficulty: bookkeeping.difficulty,
        reason: `Good start — let's fill in ${evaluation.missingElements[0] ?? "the rest"}.`,
        messageType: "FOLLOWUP",
        mode: "SOCRATIC",
      }),
      bookkeeping: resetForModeTransition(bookkeeping, "SOCRATIC", "ASK_FOLLOWUP"),
      misconceptionToRecord,
      independentCorrectEvidence: false,
    };
  }

  if (score >= TEACH_BACK_BAND_REMEDIATION) {
    return {
      decision: buildDecision({
        action: "REMEDIATE",
        conceptId: ctx.conceptId,
        difficulty: Math.max(1, bookkeeping.difficulty - 1),
        reason: `Let's shore up ${ctx.conceptName} before trying to explain it again.`,
        messageType: "REMEDIATION",
        mode: "REMEDIATION",
      }),
      bookkeeping: resetForModeTransition(bookkeeping, "REMEDIATION", "REMEDIATE"),
      misconceptionToRecord,
      independentCorrectEvidence: false,
    };
  }

  if (ctx.prerequisiteState.blocked && ctx.prerequisiteState.blockingConceptId) {
    return {
      decision: buildDecision({
        action: "CHECK_PREREQUISITE",
        conceptId: ctx.prerequisiteState.blockingConceptId,
        difficulty: 1,
        reason: `${ctx.prerequisiteState.blockingConceptName} looks like the real gap here.`,
        messageType: "REMEDIATION",
        mode: "REMEDIATION",
      }),
      bookkeeping: resetForModeTransition(bookkeeping, "REMEDIATION", "CHECK_PREREQUISITE"),
      misconceptionToRecord,
      independentCorrectEvidence: false,
    };
  }

  return {
    decision: buildDecision({
      action: "REMEDIATE",
      conceptId: ctx.conceptId,
      difficulty: 1,
      reason: `Let's rebuild ${ctx.conceptName} from the basics.`,
      messageType: "REMEDIATION",
      mode: "REMEDIATION",
    }),
    bookkeeping: resetForModeTransition(bookkeeping, "REMEDIATION", "REMEDIATE"),
    misconceptionToRecord,
    independentCorrectEvidence: false,
  };
}
