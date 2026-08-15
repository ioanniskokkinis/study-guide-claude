import { describe, expect, it } from "vitest";
import { nextSocraticDecision } from "@/lib/tutor/socratic";
import { REPEATED_FAILURE_THRESHOLD } from "@/lib/tutor/config";
import { buildBookkeeping, buildContext, buildEvaluation } from "./fixtures";

describe("socratic mode decisions (spec §7-10, §25)", () => {
  it("partial answer -> follow-up", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping();
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "PARTIALLY_CORRECT" }), "PARTIALLY_CORRECT");
    expect(result.decision.action).toBe("ASK_FOLLOWUP");
    expect(result.bookkeeping.socraticDepth).toBe(1);
  });

  it("correct answer (uncertain/no self-report) -> progress via follow-up", () => {
    const ctx = buildContext({ masteryBucket: "developing" });
    const bookkeeping = buildBookkeeping();
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "CORRECT" }), "CORRECT", null);
    expect(result.decision.action).toBe("ASK_FOLLOWUP");
    expect(result.bookkeeping.consecutiveCorrect).toBe(1);
    expect(result.independentCorrectEvidence).toBe(true);
  });

  it("correct + confident -> increase difficulty (spec §25)", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ difficulty: 2 });
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "CORRECT" }), "CORRECT", "CONFIDENT");
    expect(result.decision.action).toBe("INCREASE_DIFFICULTY");
    expect(result.decision.difficulty).toBe(3);
  });

  it("a genuine streak at strong mastery deepens into a transfer question", () => {
    const ctx = buildContext({ masteryBucket: "strong" });
    const bookkeeping = buildBookkeeping({ consecutiveCorrect: 1 });
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "CORRECT" }), "CORRECT", null);
    expect(result.decision.action).toBe("DEEPEN");
  });

  it("correct answer given after a hint is not independent evidence", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ hintLevel: 2 });
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "CORRECT" }), "CORRECT", null);
    expect(result.independentCorrectEvidence).toBe(false);
  });

  it("first incorrect -> simplify, not an immediate hint", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping();
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "INCORRECT" }), "INCORRECT");
    expect(result.decision.action).toBe("SIMPLIFY");
    expect(result.bookkeeping.socraticDepth).toBe(1);
  });

  it("second incorrect escalates to HINT_1", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ socraticDepth: 1, consecutiveIncorrect: 1 });
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "INCORRECT" }), "INCORRECT");
    expect(result.decision.action).toBe("GIVE_HINT");
    expect(result.bookkeeping.hintLevel).toBe(1);
  });

  it("depth exhausted (past MAX_SOCRATIC_DEPTH) -> direct explanation", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ socraticDepth: 4, consecutiveIncorrect: 0, hintLevel: 3 });
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "INCORRECT" }), "INCORRECT");
    expect(result.decision.action).toBe("GIVE_EXPLANATION");
    expect(result.bookkeeping.socraticDepth).toBe(0);
  });

  it(`repeated failure (${REPEATED_FAILURE_THRESHOLD} in a row) -> remediation`, () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ consecutiveIncorrect: REPEATED_FAILURE_THRESHOLD - 1 });
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "INCORRECT" }), "INCORRECT");
    expect(result.decision.action).toBe("REMEDIATE");
    expect(result.bookkeeping.mode).toBe("REMEDIATION");
  });

  it("explanations rotate strategy — never repeats the immediately previous one", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ socraticDepth: 4, lastExplanationStrategy: "analogy" });
    const result = nextSocraticDecision(ctx, bookkeeping, buildEvaluation({ classification: "INCORRECT" }), "INCORRECT");
    expect(result.bookkeeping.lastExplanationStrategy).not.toBe("analogy");
  });
});
