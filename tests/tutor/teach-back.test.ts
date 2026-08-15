import { describe, expect, it } from "vitest";
import { nextTeachBackDecision, scoreTeachBack } from "@/lib/tutor/teach-back";
import { buildBookkeeping, buildContext, buildTeachBackEvaluation } from "./fixtures";

describe("scoreTeachBack (spec §20)", () => {
  it("stays within [0,1] for a perfect explanation", () => {
    const score = scoreTeachBack(buildTeachBackEvaluation({ correctness: 1, completeness: 1, conceptualAccuracy: 1, misconceptions: [] }));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeCloseTo(1, 5);
  });

  it("misconceptions reduce the score even when the numeric dimensions are high", () => {
    const clean = scoreTeachBack(buildTeachBackEvaluation({ misconceptions: [] }));
    const withMisconception = scoreTeachBack(buildTeachBackEvaluation({ misconceptions: ["Thinks a firewall assigns ports."] }));
    expect(withMisconception).toBeLessThan(clean);
  });
});

describe("teach-back mode decisions (spec §18-21)", () => {
  it("a strong explanation (>=0.85) earns a transfer question (challenge)", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ mode: "TEACH_BACK", difficulty: 2 });
    const evaluation = buildTeachBackEvaluation({ correctness: 0.95, completeness: 0.9, conceptualAccuracy: 0.9, misconceptions: [] });
    const result = nextTeachBackDecision(ctx, bookkeeping, evaluation);
    expect(result.decision.action).toBe("DEEPEN");
    expect(result.bookkeeping.mode).toBe("SOCRATIC");
    expect(result.decision.difficulty).toBe(3);
  });

  it("a partial explanation (0.60-0.84) asks a targeted follow-up", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ mode: "TEACH_BACK" });
    const evaluation = buildTeachBackEvaluation({
      correctness: 0.7,
      completeness: 0.6,
      conceptualAccuracy: 0.7,
      missingElements: ["reliability mechanisms"],
      misconceptions: [],
    });
    const result = nextTeachBackDecision(ctx, bookkeeping, evaluation);
    expect(result.decision.action).toBe("ASK_FOLLOWUP");
  });

  it("a poor explanation (0.40-0.59) routes into remediation", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ mode: "TEACH_BACK" });
    const evaluation = buildTeachBackEvaluation({ correctness: 0.4, completeness: 0.4, conceptualAccuracy: 0.4, misconceptions: [] });
    const result = nextTeachBackDecision(ctx, bookkeeping, evaluation);
    expect(result.decision.action).toBe("REMEDIATE");
    expect(result.bookkeeping.mode).toBe("REMEDIATION");
  });

  it("a very poor explanation with a blocked prerequisite checks the prerequisite instead", () => {
    const ctx = buildContext({
      prerequisiteState: { blocked: true, blockingConceptId: "ports-id", blockingConceptName: "Ports", blockingMastery: 0.2 },
    });
    const bookkeeping = buildBookkeeping({ mode: "TEACH_BACK" });
    const evaluation = buildTeachBackEvaluation({ correctness: 0.1, completeness: 0.1, conceptualAccuracy: 0.1, misconceptions: [] });
    const result = nextTeachBackDecision(ctx, bookkeeping, evaluation);
    expect(result.decision.action).toBe("CHECK_PREREQUISITE");
    expect(result.decision.conceptId).toBe("ports-id");
  });

  it("a very poor explanation with no prerequisite gap falls back to remediation on the same concept", () => {
    const ctx = buildContext();
    const bookkeeping = buildBookkeeping({ mode: "TEACH_BACK" });
    const evaluation = buildTeachBackEvaluation({ correctness: 0.1, completeness: 0.1, conceptualAccuracy: 0.1, misconceptions: [] });
    const result = nextTeachBackDecision(ctx, bookkeeping, evaluation);
    expect(result.decision.action).toBe("REMEDIATE");
    expect(result.decision.conceptId).toBe(ctx.conceptId);
  });
});
