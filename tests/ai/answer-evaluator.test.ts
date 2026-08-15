import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { evaluateAnswer } from "@/lib/ai/answer-evaluator";

function baseEvaluation(overrides: Record<string, unknown> = {}) {
  return {
    score: 0.8,
    correctness: "CORRECT",
    reasoningQuality: 0.8,
    completeness: 0.8,
    strengths: ["Good"],
    missingPoints: [],
    errors: [],
    misconceptions: [],
    feedback: "Nicely done.",
    correctAnswer: "The reference answer.",
    needsRemediation: false,
    ...overrides,
  };
}

const baseInput = {
  conceptName: "Firewalls",
  conceptDescription: "Devices that filter traffic.",
  questionPrompt: "What does a stateful firewall track?",
  questionType: "RECALL",
  expectedAnswer: "Connection state.",
  rubric: ["Mentions connection state"],
  sourceChunks: [{ id: "c1", text: "Stateful firewalls track connection state." }],
  knownPrerequisites: [{ id: "ports-id", name: "Ports" }],
  studentAnswer: "It tracks connection state.",
  studentConfidence: 0.8,
};

describe("evaluateAnswer", () => {
  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("maps CORRECT/PARTIAL/INCORRECT to the SUCCESS/PARTIAL/FAILURE outcome recordLearningOutcome expects", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: baseEvaluation({ correctness: "PARTIAL" }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await evaluateAnswer(baseInput);
    expect(result.correctness).toBe("PARTIAL");
    expect(result.outcome).toBe("PARTIAL");
  });

  it("resolves prerequisiteGapConceptName to an id only when it matches a known prerequisite (never trusts an invented one)", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: baseEvaluation({ prerequisiteGapConceptName: "Ports" }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await evaluateAnswer(baseInput);
    expect(result.prerequisiteGapConceptId).toBe("ports-id");
  });

  it("drops a prerequisite gap name that isn't in the known prerequisites list — never invents a graph edge", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: baseEvaluation({ prerequisiteGapConceptName: "Made Up Prerequisite" }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await evaluateAnswer(baseInput);
    expect(result.prerequisiteGapConceptId).toBeNull();
  });

  it("distinguishes a misconception from a plain error in the returned result", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: baseEvaluation({
        correctness: "INCORRECT",
        errors: [{ category: "CONCEPTUAL_GAP", description: "Missing key detail.", severity: "MEDIUM" }],
        misconceptions: [{ description: "Believes it only checks destination port.", severity: "HIGH" }],
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await evaluateAnswer(baseInput);
    expect(result.errors).toHaveLength(1);
    expect(result.misconceptions).toHaveLength(1);
    expect(result.outcome).toBe("FAILURE");
  });
});
