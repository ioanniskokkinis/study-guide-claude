import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { extractConceptsFromChunks } from "@/lib/knowledge/concept-extractor";

describe("extractConceptsFromChunks", () => {
  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("drops concepts whose evidence references a chunk outside the batch (hallucination guard)", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        concepts: [
          { name: "TCP", description: "...", difficulty: 2, evidence: [{ chunkId: "does-not-exist", text: "x" }] },
          { name: "Ports", description: "...", difficulty: 2, evidence: [{ chunkId: "c1", text: "real" }] },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await extractConceptsFromChunks("Course", [{ id: "c1", text: "..." }]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Ports");
  });

  it("batches chunks so no single request exceeds the configured batch size", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: { concepts: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const chunks = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, text: `chunk ${i}` }));
    await extractConceptsFromChunks("Course", chunks);

    // CHUNKS_PER_CONCEPT_EXTRACTION_BATCH is 6: 14 chunks -> batches of 6, 6, 2 -> 3 calls.
    expect(extractStructured).toHaveBeenCalledTimes(3);
  });

  it("returns nothing for an empty chunk list without calling Claude", async () => {
    const result = await extractConceptsFromChunks("Course", []);
    expect(result).toEqual([]);
    expect(extractStructured).not.toHaveBeenCalled();
  });
});
