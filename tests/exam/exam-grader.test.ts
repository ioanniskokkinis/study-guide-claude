import { describe, expect, it } from "vitest";
import {
  classifyFromScore,
  computeFinalScoreFromCriteria,
  evidenceScoreForExamAnswer,
  gradeFromRubric,
  gradeMultiSelect,
  gradeSingleSelect,
} from "@/lib/exam/exam-grader";
import type { AnswerGrading } from "@/lib/exam/types";

function grading(overrides: Partial<AnswerGrading> = {}): AnswerGrading {
  return {
    classification: "CORRECT",
    criteria: { correctness: 1, completeness: 1, reasoning: 1, application: 1, conceptualUnderstanding: 1 },
    missingConcepts: [],
    misconceptions: [],
    severity: null,
    feedback: "Good.",
    ...overrides,
  };
}

describe("gradeSingleSelect (MULTIPLE_CHOICE / TRUE_FALSE, spec §60 — no Claude call)", () => {
  it("a correct answer scores 100%", () => {
    expect(gradeSingleSelect(["a"], ["a"])).toEqual({ classification: "CORRECT", score: 1 });
  });

  it("an incorrect answer scores 0%", () => {
    expect(gradeSingleSelect(["b"], ["a"])).toEqual({ classification: "INCORRECT", score: 0 });
  });

  it("no selection is UNANSWERED, not INCORRECT", () => {
    expect(gradeSingleSelect([], ["a"])).toEqual({ classification: "UNANSWERED", score: 0 });
  });

  it("selecting more than one option on a single-select question is incorrect", () => {
    expect(gradeSingleSelect(["a", "b"], ["a"])).toEqual({ classification: "INCORRECT", score: 0 });
  });
});

describe("gradeMultiSelect (partial credit)", () => {
  it("all correct options selected, none wrong -> full credit", () => {
    const result = gradeMultiSelect(["a", "b"], ["a", "b"]);
    expect(result.score).toBe(1);
    expect(result.classification).toBe("CORRECT");
  });

  it("half the correct options selected -> partial credit", () => {
    const result = gradeMultiSelect(["a"], ["a", "b"]);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  it("a wrong option selected alongside a right one reduces the score", () => {
    const withWrong = gradeMultiSelect(["a", "c"], ["a", "b"]);
    const withoutWrong = gradeMultiSelect(["a"], ["a", "b"]);
    expect(withWrong.score).toBeLessThan(withoutWrong.score);
  });

  it("never goes below zero even when everything selected is wrong", () => {
    const result = gradeMultiSelect(["c", "d"], ["a", "b"]);
    expect(result.score).toBe(0);
  });
});

describe("computeFinalScoreFromCriteria (spec §22-23 — deterministic, never Claude-decided)", () => {
  it("stays within [0,1] for a perfect answer", () => {
    const score = computeFinalScoreFromCriteria({ correctness: 1, completeness: 1, reasoning: 1, application: 1, conceptualUnderstanding: 1 });
    expect(score).toBeCloseTo(1, 5);
  });

  it("weights correctness most heavily", () => {
    const highCorrectness = computeFinalScoreFromCriteria({ correctness: 1, completeness: 0, reasoning: 0, application: 0, conceptualUnderstanding: 0 });
    const highApplication = computeFinalScoreFromCriteria({ correctness: 0, completeness: 0, reasoning: 0, application: 1, conceptualUnderstanding: 0 });
    expect(highCorrectness).toBeGreaterThan(highApplication);
  });
});

describe("classifyFromScore", () => {
  it("bands scores into CORRECT / PARTIALLY_CORRECT / INCORRECT", () => {
    expect(classifyFromScore(0.9)).toBe("CORRECT");
    expect(classifyFromScore(0.5)).toBe("PARTIALLY_CORRECT");
    expect(classifyFromScore(0.1)).toBe("INCORRECT");
  });
});

describe("gradeFromRubric", () => {
  it("empty answer text is UNANSWERED regardless of criteria", () => {
    const result = gradeFromRubric("", grading());
    expect(result).toEqual({ classification: "UNANSWERED", score: 0 });
  });

  it("a strong answer grades as CORRECT with a score derived from criteria, not Claude's own classification", () => {
    const result = gradeFromRubric("A real answer.", grading({ classification: "CORRECT" }));
    expect(result.classification).toBe("CORRECT");
    expect(result.score).toBeCloseTo(1, 5);
  });

  it("Claude claiming CORRECT with low criteria scores does not inflate the grade", () => {
    const result = gradeFromRubric(
      "A weak answer.",
      grading({ classification: "CORRECT", criteria: { correctness: 0.2, completeness: 0.2, reasoning: 0.2, application: 0.2, conceptualUnderstanding: 0.2 } }),
    );
    expect(result.classification).toBe("INCORRECT");
    expect(result.score).toBeLessThan(0.4);
  });

  it("preserves a MISCONCEPTION classification (not derivable from the score alone)", () => {
    const result = gradeFromRubric("A confidently wrong answer.", grading({ classification: "MISCONCEPTION" }));
    expect(result.classification).toBe("MISCONCEPTION");
  });
});

describe("evidenceScoreForExamAnswer (spec §15, §24 — mirrors Phase 7's hint-discount principle)", () => {
  it("no hint used -> full evidence weight", () => {
    expect(evidenceScoreForExamAnswer(0.9, 0, false)).toBe(0.9);
  });

  it("a hint used -> weakened evidence weight", () => {
    const withHint = evidenceScoreForExamAnswer(0.9, 1, false);
    expect(withHint).toBeLessThan(0.9);
    expect(withHint).toBeGreaterThan(0);
  });

  it("a revealed answer produces no independent evidence at all", () => {
    expect(evidenceScoreForExamAnswer(0.9, 0, true)).toBeNull();
  });
});
