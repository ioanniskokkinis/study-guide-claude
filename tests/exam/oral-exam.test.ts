import { describe, expect, it } from "vitest";
import { cognitiveLevelForDepth, nextOralProgression, shouldAdvanceToNextConcept } from "@/lib/exam/oral-exam";
import { ORAL_MAX_CONSECUTIVE_WEAK, ORAL_MAX_DEPTH } from "@/lib/exam/config";

describe("cognitiveLevelForDepth (spec §30)", () => {
  it("maps depth levels 1-5 to the spec's cognitive progression", () => {
    expect(cognitiveLevelForDepth(1)).toBe("RECALL");
    expect(cognitiveLevelForDepth(2)).toBe("UNDERSTAND");
    expect(cognitiveLevelForDepth(3)).toBe("APPLY");
    expect(cognitiveLevelForDepth(4)).toBe("ANALYZE");
    expect(cognitiveLevelForDepth(5)).toBe("EVALUATE");
  });

  it("clamps out-of-range depths", () => {
    expect(cognitiveLevelForDepth(0)).toBe("RECALL");
    expect(cognitiveLevelForDepth(99)).toBe("EVALUATE");
  });
});

describe("nextOralProgression (spec §29-31 — follow-ups depend on the previous response)", () => {
  it("a correct answer goes one level deeper", () => {
    const result = nextOralProgression(1, 0, "CORRECT");
    expect(result.nextDepth).toBe(2);
    expect(result.consecutiveWeak).toBe(0);
  });

  it("a partially correct answer still counts as strong enough to deepen", () => {
    const result = nextOralProgression(2, 0, "PARTIALLY_CORRECT");
    expect(result.nextDepth).toBe(3);
  });

  it("an incorrect answer holds at the same depth and starts a weak streak", () => {
    const result = nextOralProgression(2, 0, "INCORRECT");
    expect(result.nextDepth).toBe(2);
    expect(result.consecutiveWeak).toBe(1);
  });

  it(`does not always reach level ${ORAL_MAX_DEPTH} — adapts to performance by advancing after ${ORAL_MAX_CONSECUTIVE_WEAK} weak answers in a row`, () => {
    const first = nextOralProgression(2, 0, "INCORRECT");
    const second = nextOralProgression(first.nextDepth, first.consecutiveWeak, "INCORRECT");
    expect(second.advanceToNextConcept).toBe(true);
  });

  it("reaching the max depth on a strong answer also advances to the next concept", () => {
    const result = nextOralProgression(ORAL_MAX_DEPTH, 0, "CORRECT");
    expect(result.advanceToNextConcept).toBe(true);
  });

  it("a single weak answer alone does not force advancement", () => {
    expect(shouldAdvanceToNextConcept(2, 1)).toBe(false);
  });
});
