import { describe, expect, it } from "vitest";
import { applyExamModeBias, examModePhase } from "@/lib/advisor/exam-mode";

/** Phase 16 §34-35, §63 — exam-mode phase + action bias, pure functions, no second exam system. */
describe("examModePhase", () => {
  const now = new Date("2026-08-16T00:00:00Z");

  it("returns NONE when there is no deadline", () => {
    expect(examModePhase(null, now)).toBe("NONE");
  });

  it("returns FAR when the deadline is well beyond the approaching window", () => {
    expect(examModePhase(new Date("2026-09-30T00:00:00Z"), now)).toBe("FAR");
  });

  it("returns APPROACHING within the approaching-days window", () => {
    expect(examModePhase(new Date("2026-08-25T00:00:00Z"), now)).toBe("APPROACHING");
  });

  it("returns IMMINENT within the imminent-days window", () => {
    expect(examModePhase(new Date("2026-08-17T00:00:00Z"), now)).toBe("IMMINENT");
  });
});

describe("applyExamModeBias", () => {
  it("never overrides LEARN regardless of phase", () => {
    expect(applyExamModeBias("LEARN", "IMMINENT", true)).toBe("LEARN");
    expect(applyExamModeBias("LEARN", "APPROACHING", false)).toBe("LEARN");
  });

  it("leaves the action unchanged when the deadline is far away", () => {
    expect(applyExamModeBias("REVIEW", "FAR", true)).toBe("REVIEW");
    expect(applyExamModeBias("PRACTICE", "NONE", false)).toBe("PRACTICE");
  });

  it("biases REVIEW toward ACTIVE_RECALL when the deadline is approaching", () => {
    expect(applyExamModeBias("REVIEW", "APPROACHING", false)).toBe("ACTIVE_RECALL");
  });

  it("biases a weak concept toward REVIEW when the deadline is imminent", () => {
    expect(applyExamModeBias("PRACTICE", "IMMINENT", true)).toBe("REVIEW");
  });

  it("biases a non-weak concept toward EXAM_PRACTICE when the deadline is imminent", () => {
    expect(applyExamModeBias("PRACTICE", "IMMINENT", false)).toBe("EXAM_PRACTICE");
  });
});
