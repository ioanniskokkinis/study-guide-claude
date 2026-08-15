import { describe, expect, it } from "vitest";
import { decideNextAction } from "@/lib/tutor/tutor-decision";
import { COMPLETION_CORRECT_STREAK } from "@/lib/tutor/config";
import { buildBookkeeping, buildContext, buildEvaluation } from "./fixtures";

describe("decideNextAction — cross-cutting concerns (spec §4-5, §39)", () => {
  it("session start dispatches per mode: SOCRATIC -> ASK_QUESTION", () => {
    const result = decideNextAction({
      ctx: buildContext(),
      bookkeeping: buildBookkeeping({ mode: "SOCRATIC" }),
      turn: null,
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("ASK_QUESTION");
  });

  it("session start dispatches per mode: TEACH_BACK -> TEACH_BACK", () => {
    const result = decideNextAction({
      ctx: buildContext(),
      bookkeeping: buildBookkeeping({ mode: "TEACH_BACK" }),
      turn: null,
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("TEACH_BACK");
  });

  it("session start dispatches per mode: REMEDIATION -> REMEDIATE", () => {
    const result = decideNextAction({
      ctx: buildContext(),
      bookkeeping: buildBookkeeping({ mode: "REMEDIATION" }),
      turn: null,
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("REMEDIATE");
  });

  it("a MISCONCEPTION classification with a blocked prerequisite redirects to the blocking concept", () => {
    const ctx = buildContext({
      prerequisiteState: { blocked: true, blockingConceptId: "ports-id", blockingConceptName: "Ports", blockingMastery: 0.15 },
    });
    const result = decideNextAction({
      ctx,
      bookkeeping: buildBookkeeping(),
      turn: {
        kind: "response",
        data: buildEvaluation({ classification: "MISCONCEPTION", misconceptionDescription: "Thinks a firewall assigns ports.", severity: "HIGH" }),
        selfReportedConfidence: null,
      },
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("CHECK_PREREQUISITE");
    expect(result.decision.conceptId).toBe("ports-id");
    expect(result.misconceptionToRecord?.severity).toBe("HIGH");
  });

  it("a MISCONCEPTION classification with no prerequisite gap remediates the same concept", () => {
    const ctx = buildContext();
    const result = decideNextAction({
      ctx,
      bookkeeping: buildBookkeeping(),
      turn: { kind: "response", data: buildEvaluation({ classification: "MISCONCEPTION", severity: "MEDIUM" }), selfReportedConfidence: null },
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("REMEDIATE");
    expect(result.decision.conceptId).toBe(ctx.conceptId);
  });

  it("illusion of competence: a confident but incorrect answer escalates to a misconception override", () => {
    const ctx = buildContext();
    const result = decideNextAction({
      ctx,
      bookkeeping: buildBookkeeping(),
      turn: { kind: "response", data: buildEvaluation({ classification: "INCORRECT" }), selfReportedConfidence: "CONFIDENT" },
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("REMEDIATE");
    expect(result.misconceptionToRecord).not.toBeNull();
  });

  it("an unconfident incorrect answer does NOT trigger the misconception override (first miss -> simplify)", () => {
    const ctx = buildContext();
    const result = decideNextAction({
      ctx,
      bookkeeping: buildBookkeeping(),
      turn: { kind: "response", data: buildEvaluation({ classification: "INCORRECT" }), selfReportedConfidence: "UNSURE" },
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("SIMPLIFY");
    expect(result.misconceptionToRecord).toBeNull();
  });

  it("explicit reveal request ('just tell me') gives an explanation, sets hint level to REVEAL, and is not independent evidence", () => {
    const result = decideNextAction({
      ctx: buildContext(),
      bookkeeping: buildBookkeeping(),
      turn: { kind: "response", data: buildEvaluation(), selfReportedConfidence: null },
      explicitDontKnow: false,
      explicitRevealRequest: true,
    });
    expect(result.decision.action).toBe("GIVE_EXPLANATION");
    expect(result.decision.metadata.revealed).toBe(true);
    expect(result.bookkeeping.hintLevel).toBe(4);
    expect(result.bookkeeping.answerRevealed).toBe(true);
    expect(result.independentCorrectEvidence).toBe(false);
  });

  it("explicit 'I don't know' gives a hint rather than treating it as a normal wrong answer", () => {
    const result = decideNextAction({
      ctx: buildContext(),
      bookkeeping: buildBookkeeping({ hintLevel: 0 }),
      turn: { kind: "response", data: buildEvaluation(), selfReportedConfidence: null },
      explicitDontKnow: true,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("GIVE_HINT");
    expect(result.bookkeeping.hintLevel).toBe(1);
    // Unlike a real incorrect answer, "I don't know" never touches the repeated-failure counter.
    expect(result.bookkeeping.consecutiveIncorrect).toBe(0);
  });

  it("explicit 'I don't know' after hints are exhausted gives an explanation instead", () => {
    const result = decideNextAction({
      ctx: buildContext(),
      bookkeeping: buildBookkeeping({ hintLevel: 3 }),
      turn: { kind: "response", data: buildEvaluation(), selfReportedConfidence: null },
      explicitDontKnow: true,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("GIVE_EXPLANATION");
  });

  it(`completion override: ${COMPLETION_CORRECT_STREAK} consecutive correct answers with no misconception completes the session`, () => {
    const ctx = buildContext();
    const result = decideNextAction({
      ctx,
      bookkeeping: buildBookkeeping({ consecutiveCorrect: COMPLETION_CORRECT_STREAK - 1 }),
      turn: { kind: "response", data: buildEvaluation({ classification: "CORRECT" }), selfReportedConfidence: null },
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).toBe("COMPLETE");
  });

  it("completion is withheld while a high-severity misconception is still active, even with a correct streak", () => {
    const ctx = buildContext({
      misconceptionState: [{ id: "m1", description: "x", severity: "HIGH", confidence: 0.9, occurrenceCount: 1, correctSinceCount: 0 }],
    });
    const result = decideNextAction({
      ctx,
      bookkeeping: buildBookkeeping({ consecutiveCorrect: COMPLETION_CORRECT_STREAK - 1 }),
      turn: { kind: "response", data: buildEvaluation({ classification: "CORRECT" }), selfReportedConfidence: null },
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });
    expect(result.decision.action).not.toBe("COMPLETE");
  });
});
