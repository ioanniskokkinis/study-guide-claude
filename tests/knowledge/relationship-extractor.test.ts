import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { extractRelationships } from "@/lib/knowledge/relationship-extractor";
import { extractPrerequisites } from "@/lib/knowledge/prerequisite-analyzer";

const concepts = [
  { name: "TCP", description: "...", difficulty: 2, evidenceSnippets: [] },
  { name: "Ports", description: "...", difficulty: 2, evidenceSnippets: [] },
];

describe("extractRelationships", () => {
  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("drops relationships referencing a concept name outside the known set (never trust arbitrary model output)", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        relationships: [
          {
            sourceConceptName: "TCP",
            targetConceptName: "Imaginary Concept",
            relationshipType: "related",
            confidence: 0.9,
            evidence: "hallucinated",
          },
          {
            sourceConceptName: "TCP",
            targetConceptName: "Ports",
            relationshipType: "related",
            confidence: 0.9,
            evidence: "real",
          },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await extractRelationships("Course", concepts);

    expect(result).toHaveLength(1);
    expect(result[0].targetConceptName).toBe("Ports");
  });

  it("skips a batch that stays invalid after retrying, instead of throwing and losing the whole pass (production-hardening §A6/§A7)", async () => {
    vi.mocked(extractStructured).mockRejectedValue(new Error("Failed to parse structured output as JSON: Unterminated string"));

    const result = await extractRelationships("Course", concepts);
    expect(result).toEqual([]);
  });
});

describe("extractPrerequisites", () => {
  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("drops prerequisite edges referencing a concept name outside the known set", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        prerequisites: [
          {
            prerequisiteConceptName: "TCP",
            dependentConceptName: "Made Up Concept",
            confidence: 0.9,
            evidence: "hallucinated",
          },
          { prerequisiteConceptName: "TCP", dependentConceptName: "Ports", confidence: 0.9, evidence: "real" },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await extractPrerequisites("Course", concepts);

    expect(result).toHaveLength(1);
    expect(result[0].dependentConceptName).toBe("Ports");
  });
});
