import { describe, expect, it } from "vitest";
import { classifyExamMistakeCategory, computeMistakeSeverity, toStudentMistakeCategory } from "@/lib/exam/mistake-analyzer";
import type { ClassifyMistakeInput } from "@/lib/exam/mistake-analyzer";

function baseInput(overrides: Partial<ClassifyMistakeInput> = {}): ClassifyMistakeInput {
  return {
    questionId: "q1",
    conceptId: "c1",
    conceptName: "Firewalls",
    classification: "INCORRECT",
    confidence: null,
    criteria: null,
    cognitiveLevel: "RECALL",
    missingConceptsCount: 0,
    underTimePressure: false,
    ...overrides,
  };
}

describe("classifyExamMistakeCategory (spec §24-25, §19)", () => {
  it("a confident but incorrect answer escalates to MISCONCEPTION even without Claude flagging one (illusion of competence, spec §19)", () => {
    const category = classifyExamMistakeCategory(baseInput({ classification: "INCORRECT", confidence: "CONFIDENT" }));
    expect(category).toBe("MISCONCEPTION");
  });

  it("Claude's own MISCONCEPTION classification is preserved", () => {
    expect(classifyExamMistakeCategory(baseInput({ classification: "MISCONCEPTION" }))).toBe("MISCONCEPTION");
  });

  it("an unanswered question with no time pressure is INCOMPLETE_ANSWER", () => {
    expect(classifyExamMistakeCategory(baseInput({ classification: "UNANSWERED" }))).toBe("INCOMPLETE_ANSWER");
  });

  it("an unanswered question near the time limit is TIME_PRESSURE", () => {
    expect(classifyExamMistakeCategory(baseInput({ classification: "UNANSWERED", underTimePressure: true }))).toBe("TIME_PRESSURE");
  });

  it("an auto-graded wrong answer (no rubric criteria) defaults to RECALL_FAILURE", () => {
    expect(classifyExamMistakeCategory(baseInput({ classification: "INCORRECT", criteria: null }))).toBe("RECALL_FAILURE");
  });

  it("low completeness with otherwise-decent correctness is INCOMPLETE_ANSWER", () => {
    const category = classifyExamMistakeCategory(
      baseInput({ criteria: { correctness: 0.6, completeness: 0.2, reasoning: 0.6, application: 0.6, conceptualUnderstanding: 0.6 } }),
    );
    expect(category).toBe("INCOMPLETE_ANSWER");
  });

  it("weak application relative to reasoning on an APPLY-level question is APPLICATION_FAILURE", () => {
    const category = classifyExamMistakeCategory(
      baseInput({
        cognitiveLevel: "APPLY",
        criteria: { correctness: 0.6, completeness: 0.6, reasoning: 0.7, application: 0.3, conceptualUnderstanding: 0.6 },
      }),
    );
    expect(category).toBe("APPLICATION_FAILURE");
  });

  it("reasoning notably weaker than correctness is REASONING_FAILURE", () => {
    const category = classifyExamMistakeCategory(
      baseInput({ criteria: { correctness: 0.8, completeness: 0.7, reasoning: 0.3, application: 0.7, conceptualUnderstanding: 0.7 } }),
    );
    expect(category).toBe("REASONING_FAILURE");
  });
});

describe("computeMistakeSeverity (spec §25)", () => {
  it("stays within LOW/MEDIUM/HIGH/CRITICAL bounds", () => {
    const bands = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const severity = computeMistakeSeverity({ conceptImportance: 0.5, occurrencesThisExam: 1, hasPrerequisiteImpact: false, confidence: null });
    expect(bands).toContain(severity);
  });

  it("a high-importance concept with prerequisite impact and confident-wrong answers scores as severe", () => {
    const severity = computeMistakeSeverity({ conceptImportance: 1, occurrencesThisExam: 3, hasPrerequisiteImpact: true, confidence: "CONFIDENT" });
    expect(severity).toBe("CRITICAL");
  });

  it("a low-importance, isolated, unsure mistake scores as mild", () => {
    const severity = computeMistakeSeverity({ conceptImportance: 0.1, occurrencesThisExam: 1, hasPrerequisiteImpact: false, confidence: "GUESSING" });
    expect(severity).toBe("LOW");
  });
});

describe("toStudentMistakeCategory (reuses the existing mistake infrastructure, spec §24)", () => {
  it("maps every exam mistake category to a valid StudentMistakeCategory", () => {
    const categories: Array<Parameters<typeof toStudentMistakeCategory>[0]> = [
      "KNOWLEDGE_GAP",
      "MISCONCEPTION",
      "RECALL_FAILURE",
      "REASONING_FAILURE",
      "APPLICATION_FAILURE",
      "PREREQUISITE_FAILURE",
      "CARELESS_ERROR",
      "INCOMPLETE_ANSWER",
      "TIME_PRESSURE",
      "UNKNOWN",
    ];
    for (const category of categories) {
      expect(typeof toStudentMistakeCategory(category)).toBe("string");
    }
    expect(toStudentMistakeCategory("MISCONCEPTION")).toBe("MISCONCEPTION");
    expect(toStudentMistakeCategory("PREREQUISITE_FAILURE")).toBe("PREREQUISITE_GAP");
  });
});
