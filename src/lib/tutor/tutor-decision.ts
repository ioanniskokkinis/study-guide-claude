import { hasActiveHighSeverityMisconception } from "./misconceptions";
import { nextHintLevel } from "./hints";
import { COMPLETION_CORRECT_STREAK, ILLUSION_OF_COMPETENCE_SEVERITY } from "./config";
import { nextSocraticDecision } from "./socratic";
import { nextRemediationDecision } from "./remediation";
import { nextTeachBackDecision } from "./teach-back";
import {
  buildDecision,
  CONTINUATION_ACTIONS,
  resetForModeTransition,
  type DecisionResult,
  type SessionBookkeeping,
  type TurnEvaluation,
} from "./decision-support";
import type { ConfidenceLevel, ResponseClassification, ResponseEvaluation, TutorContext } from "./types";

export type { SessionBookkeeping, TurnEvaluation, DecisionResult } from "./decision-support";
export { buildDecision, resetForModeTransition } from "./decision-support";

export interface DecisionInput {
  ctx: TutorContext;
  bookkeeping: SessionBookkeeping;
  /** null only for the very first turn of a session (no student response yet). */
  turn: TurnEvaluation | null;
  explicitDontKnow: boolean;
  explicitRevealRequest: boolean;
}

/**
 * The deterministic core of the Intelligent Tutor Engine (spec §2, §4-5,
 * §39). Given the student's current state and (if any) the evaluation of
 * their latest response, decides the single next pedagogically useful
 * action — Claude never picks this value; it only generates the language
 * for whatever action is decided here (spec §5).
 *
 * Cross-cutting concerns that apply regardless of mode are resolved first
 * ("just tell me", "I don't know", illusion of competence, misconception /
 * prerequisite override, session completion); mode-specific progression
 * (Socratic depth, the remediation loop, teach-back score bands) is
 * delegated to socratic.ts / remediation.ts / teach-back.ts so none of that
 * logic is duplicated here (spec §6, §40).
 */
export function decideNextAction(input: DecisionInput): DecisionResult {
  const { ctx, bookkeeping, turn } = input;

  if (turn === null) {
    return startSession(ctx, bookkeeping);
  }

  if (input.explicitRevealRequest) {
    return {
      decision: buildDecision({
        action: "GIVE_EXPLANATION",
        conceptId: ctx.conceptId,
        difficulty: bookkeeping.difficulty,
        reason: "You asked for the answer directly.",
        messageType: "EXPLANATION",
        mode: bookkeeping.mode,
        metadata: { revealed: true },
      }),
      bookkeeping: { ...bookkeeping, hintLevel: 4, answerRevealed: true, lastAction: "GIVE_EXPLANATION" },
      misconceptionToRecord: null,
      independentCorrectEvidence: false,
    };
  }

  if (input.explicitDontKnow) {
    const giveExplanation = bookkeeping.hintLevel >= 3;
    return {
      decision: buildDecision({
        action: giveExplanation ? "GIVE_EXPLANATION" : "GIVE_HINT",
        conceptId: ctx.conceptId,
        difficulty: bookkeeping.difficulty,
        reason: giveExplanation ? "Let's walk through this together." : "A nudge in the right direction.",
        messageType: giveExplanation ? "EXPLANATION" : "HINT",
        mode: bookkeeping.mode,
      }),
      bookkeeping: giveExplanation
        ? { ...bookkeeping, lastAction: "GIVE_EXPLANATION" }
        : { ...bookkeeping, hintLevel: nextHintLevel(bookkeeping.hintLevel), lastAction: "GIVE_HINT" },
      misconceptionToRecord: null,
      independentCorrectEvidence: false,
    };
  }

  if (turn.kind === "teachback") {
    return withCompletionOverride(nextTeachBackDecision(ctx, bookkeeping, turn.data), ctx);
  }

  const classification = escalateForIllusionOfCompetence(turn.data, turn.selfReportedConfidence);

  // Misconception (including an illusion-of-competence escalation) is a
  // universal override: whatever mode we're in, a misconception needs to be
  // confronted before anything else continues (spec §14, §52).
  if (classification === "MISCONCEPTION") {
    const misconceptionToRecord = {
      description: turn.data.misconceptionDescription ?? `Misconception detected while studying ${ctx.conceptName}.`,
      severity: turn.data.severity ?? ILLUSION_OF_COMPETENCE_SEVERITY,
    };

    if (ctx.prerequisiteState.blocked && ctx.prerequisiteState.blockingConceptId) {
      return {
        decision: buildDecision({
          action: "CHECK_PREREQUISITE",
          conceptId: ctx.prerequisiteState.blockingConceptId,
          difficulty: 1,
          reason: `Let's step back — ${ctx.prerequisiteState.blockingConceptName} needs reinforcement before ${ctx.conceptName} will click.`,
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
        difficulty: Math.max(1, bookkeeping.difficulty - 1),
        reason: "That answer suggests a misconception worth addressing directly.",
        messageType: "REMEDIATION",
        mode: "REMEDIATION",
      }),
      bookkeeping: resetForModeTransition(bookkeeping, "REMEDIATION", "REMEDIATE"),
      misconceptionToRecord,
      independentCorrectEvidence: false,
    };
  }

  const result =
    bookkeeping.mode === "REMEDIATION"
      ? nextRemediationDecision(ctx, bookkeeping, turn.data, classification)
      : nextSocraticDecision(ctx, bookkeeping, turn.data, classification, turn.selfReportedConfidence);

  return withCompletionOverride(result, ctx);
}

function startSession(ctx: TutorContext, bookkeeping: SessionBookkeeping): DecisionResult {
  if (bookkeeping.mode === "TEACH_BACK") {
    return {
      decision: buildDecision({
        action: "TEACH_BACK",
        conceptId: ctx.conceptId,
        difficulty: bookkeeping.difficulty,
        reason: `Explaining ${ctx.conceptName} in your own words is the best test of whether you've really got it.`,
        messageType: "TEACH_BACK_PROMPT",
        mode: "TEACH_BACK",
      }),
      bookkeeping: { ...bookkeeping, lastAction: "TEACH_BACK" },
      misconceptionToRecord: null,
      independentCorrectEvidence: false,
    };
  }

  if (bookkeeping.mode === "REMEDIATION") {
    return {
      decision: buildDecision({
        action: "REMEDIATE",
        conceptId: ctx.conceptId,
        difficulty: Math.max(1, bookkeeping.difficulty - 1),
        reason: `Let's rebuild ${ctx.conceptName} from a solid foundation.`,
        messageType: "REMEDIATION",
        mode: "REMEDIATION",
      }),
      bookkeeping: { ...bookkeeping, lastAction: "REMEDIATE" },
      misconceptionToRecord: null,
      independentCorrectEvidence: false,
    };
  }

  return {
    decision: buildDecision({
      action: "ASK_QUESTION",
      conceptId: ctx.conceptId,
      difficulty: bookkeeping.difficulty,
      reason: `Starting with ${ctx.conceptName}.`,
      messageType: "QUESTION",
      mode: "SOCRATIC",
    }),
    bookkeeping: { ...bookkeeping, socraticDepth: 0, lastAction: "ASK_QUESTION" },
    misconceptionToRecord: null,
    independentCorrectEvidence: false,
  };
}

/** A confident-but-wrong answer is treated as at least as suspicious as a plain misconception (spec §30). */
function escalateForIllusionOfCompetence(
  evaluation: ResponseEvaluation,
  selfReportedConfidence: ConfidenceLevel | null,
): ResponseClassification {
  if (evaluation.classification === "INCORRECT" && selfReportedConfidence === "CONFIDENT") {
    return "MISCONCEPTION";
  }
  return evaluation.classification;
}

function withCompletionOverride(result: DecisionResult, ctx: TutorContext): DecisionResult {
  const criteriaMet =
    result.bookkeeping.consecutiveCorrect >= COMPLETION_CORRECT_STREAK &&
    !hasActiveHighSeverityMisconception(ctx.misconceptionState) &&
    !result.misconceptionToRecord;

  if (!criteriaMet || !CONTINUATION_ACTIONS.includes(result.decision.action)) {
    return result;
  }

  return {
    ...result,
    decision: buildDecision({
      action: "COMPLETE",
      conceptId: ctx.conceptId,
      difficulty: result.bookkeeping.difficulty,
      reason: `You've shown solid, independent understanding of ${ctx.conceptName}.`,
      messageType: "COMPLETION",
      mode: result.bookkeeping.mode,
    }),
  };
}
