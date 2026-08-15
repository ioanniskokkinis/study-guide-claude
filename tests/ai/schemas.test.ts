import { describe, expect, it } from "vitest";
import { ConceptExtractionSchema } from "@/lib/ai/prompts/concept-extraction";
import { RelationshipExtractionSchema } from "@/lib/ai/prompts/relationship-extraction";
import { PrerequisiteAnalysisSchema } from "@/lib/ai/prompts/prerequisite-analysis";

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
