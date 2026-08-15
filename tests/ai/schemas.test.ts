import { describe, expect, it } from "vitest";
import { ConceptExtractionSchema } from "@/lib/ai/prompts/concept-extraction";
import { RelationshipExtractionSchema } from "@/lib/ai/prompts/relationship-extraction";
import { PrerequisiteAnalysisSchema } from "@/lib/ai/prompts/prerequisite-analysis";
import { QuestionGenerationSchema } from "@/lib/ai/prompts/question-generation";
import { AnswerEvaluationSchema } from "@/lib/ai/prompts/answer-evaluation";
import { HintGenerationSchema } from "@/lib/ai/prompts/hint-generation";

describe("ConceptExtractionSchema", () => {
  it("accepts a valid payload", () => {
    const result = ConceptExtractionSchema.safeParse({
      concepts: [
        { name: "TCP", description: "A protocol.", difficulty: 3, evidence: [{ chunkId: "c1", text: "TCP is..." }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed JSON shape (missing required fields)", () => {
    const result = ConceptExtractionSchema.safeParse({ concepts: [{ name: "TCP" }] });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range difficulty value", () => {
    const result = ConceptExtractionSchema.safeParse({
      concepts: [{ name: "TCP", description: "...", difficulty: 9, evidence: [{ chunkId: "c1", text: "x" }] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a concept with no evidence", () => {
    const result = ConceptExtractionSchema.safeParse({
      concepts: [{ name: "TCP", description: "...", difficulty: 3, evidence: [] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("RelationshipExtractionSchema", () => {
  it("accepts a valid payload", () => {
    const result = RelationshipExtractionSchema.safeParse({
      relationships: [
        {
          sourceConceptName: "TCP",
          targetConceptName: "UDP",
          relationshipType: "contrasts_with",
          confidence: 0.8,
          evidence: "...",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid enum value", () => {
    const result = RelationshipExtractionSchema.safeParse({
      relationships: [
        {
          sourceConceptName: "TCP",
          targetConceptName: "UDP",
          relationshipType: "invented_type",
          confidence: 0.8,
          evidence: "...",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'prerequisite' as a relationship type — that's a dedicated pass, not this schema", () => {
    const result = RelationshipExtractionSchema.safeParse({
      relationships: [
        {
          sourceConceptName: "TCP",
          targetConceptName: "Ports",
          relationshipType: "prerequisite",
          confidence: 0.8,
          evidence: "...",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range confidence value", () => {
    const result = RelationshipExtractionSchema.safeParse({
      relationships: [
        { sourceConceptName: "TCP", targetConceptName: "UDP", relationshipType: "related", confidence: 1.5, evidence: "..." },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("PrerequisiteAnalysisSchema", () => {
  it("accepts a valid payload", () => {
    const result = PrerequisiteAnalysisSchema.safeParse({
      prerequisites: [
        { prerequisiteConceptName: "TCP", dependentConceptName: "Firewalls", confidence: 0.9, evidence: "..." },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative confidence value", () => {
    const result = PrerequisiteAnalysisSchema.safeParse({
      prerequisites: [
        { prerequisiteConceptName: "TCP", dependentConceptName: "Firewalls", confidence: -0.1, evidence: "..." },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed JSON entirely (wrong top-level shape)", () => {
    const result = PrerequisiteAnalysisSchema.safeParse("not an object");
    expect(result.success).toBe(false);
  });
});

describe("QuestionGenerationSchema", () => {
  it("accepts a full 'can generate' payload", () => {
    const result = QuestionGenerationSchema.safeParse({
      canGenerate: true,
      prompt: "What does a stateful firewall track?",
      expectedAnswer: "Connection state.",
      rubric: ["Mentions connection state", "Mentions allow/deny decisions"],
      sourceChunkIds: ["c1"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a refusal payload with just canGenerate=false and a reason", () => {
    const result = QuestionGenerationSchema.safeParse({
      canGenerate: false,
      refusalReason: "Not enough source material to write a grounded question.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a prompt that is too short to be a real question", () => {
    const result = QuestionGenerationSchema.safeParse({ canGenerate: true, prompt: "Why?" });
    expect(result.success).toBe(false);
  });
});

describe("AnswerEvaluationSchema", () => {
  const base = {
    score: 0.72,
    correctness: "PARTIAL",
    reasoningQuality: 0.68,
    completeness: 0.75,
    strengths: ["Correctly identified the core mechanism"],
    missingPoints: ["Didn't mention timeout handling"],
    errors: [],
    misconceptions: [],
    feedback: "Good start, but missing a key detail.",
    correctAnswer: "A stateful firewall tracks connection state to decide whether to allow packets.",
    needsRemediation: false,
  };

  it("accepts a valid evaluation payload", () => {
    expect(AnswerEvaluationSchema.safeParse(base).success).toBe(true);
  });

  it("never collapses correctness to a boolean — only CORRECT/PARTIAL/INCORRECT are valid", () => {
    expect(AnswerEvaluationSchema.safeParse({ ...base, correctness: true }).success).toBe(false);
    expect(AnswerEvaluationSchema.safeParse({ ...base, correctness: "WRONG" }).success).toBe(false);
  });

  it("rejects an out-of-range score", () => {
    expect(AnswerEvaluationSchema.safeParse({ ...base, score: 1.5 }).success).toBe(false);
    expect(AnswerEvaluationSchema.safeParse({ ...base, score: -0.1 }).success).toBe(false);
  });

  it("rejects an invalid mistake category", () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...base,
      errors: [{ category: "TOTALLY_WRONG", description: "x", severity: "LOW" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid severity level", () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...base,
      errors: [{ category: "FACTUAL_ERROR", description: "x", severity: "EXTREME" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a misconception distinct from a plain error (no category required)", () => {
    const result = AnswerEvaluationSchema.safeParse({
      ...base,
      misconceptions: [{ description: "Believes firewalls only check destination port.", severity: "HIGH" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("HintGenerationSchema", () => {
  it("accepts a short hint", () => {
    expect(HintGenerationSchema.safeParse({ hint: "Think about what each side needs to know first." }).success).toBe(
      true,
    );
  });

  it("rejects an empty/too-short hint", () => {
    expect(HintGenerationSchema.safeParse({ hint: "Hi" }).success).toBe(false);
  });
});
