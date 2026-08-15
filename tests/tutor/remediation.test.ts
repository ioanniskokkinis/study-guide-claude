import { describe, expect, it } from "vitest";
import { nextRemediationDecision } from "@/lib/tutor/remediation";
import { COMPLETION_CORRECT_STREAK } from "@/lib/tutor/config";
import { buildBookkeeping, buildContext, buildEvaluation } from "./fixtures";

describe("remediation mode decisions (spec §14-17)", () => {
  it("a correct answer short of the streak asks another easy question at the same difficulty", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ mode: "REMEDIATION", difficulty: 1 });
    const result = nextRemediationDecision(ctx, bookkeeping, buildEvaluation({ classification: "CORRECT" }), "CORRECT");
    expect(result.decision.action).toBe("ASK_QUESTION");
    expect(result.bookkeeping.consecutiveCorrect).toBe(1);
  });

  it(`${COMPLETION_CORRECT_STREAK} independent correct answers exit remediation via INCREASE_DIFFICULTY back to Socratic`, () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ mode: "REMEDIATION", consecutiveCorrect: COMPLETION_CORRECT_STREAK - 1, difficulty: 1 });
    const result = nextRemediationDecision(ctx, bookkeeping, buildEvaluation({ classification: "CORRECT" }), "CORRECT");
    expect(result.decision.action).toBe("INCREASE_DIFFICULTY");
    expect(result.bookkeeping.mode).toBe("SOCRATIC");
    expect(result.bookkeeping.difficulty).toBe(2);
  });

  it("an incorrect answer re-explains with a lower difficulty and a rotated strategy", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ mode: "REMEDIATION", difficulty: 2, lastExplanationStrategy: "example" });
    const result = nextRemediationDecision(ctx, bookkeeping, buildEvaluation({ classification: "INCORRECT" }), "INCORRECT");
    expect(result.decision.action).toBe("GIVE_EXPLANATION");
    expect(result.decision.difficulty).toBe(1);
    expect(result.bookkeeping.lastExplanationStrategy).not.toBe("example");
    expect(result.bookkeeping.consecutiveCorrect).toBe(0);
  });

  it("a correct answer taken with a hint is not independent evidence", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ mode: "REMEDIATION", hintLevel: 1 });
    const result = nextRemediationDecision(ctx, bookkeeping, buildEvaluation({ classification: "CORRECT" }), "CORRECT");
    expect(result.independentCorrectEvidence).toBe(false);
  });
});
