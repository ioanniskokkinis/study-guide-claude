import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateConcept } from "@/lib/knowledge/concept-extractor";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { mergeByNormalizedName, mergeSemanticDuplicates, normalizeConceptName } from "@/lib/knowledge/concept-normalizer";

describe("normalizeConceptName", () => {
  it("normalizes case and surrounding whitespace so TCP and tcp collide", () => {
    expect(normalizeConceptName("TCP")).toBe(normalizeConceptName("tcp"));
    expect(normalizeConceptName("  TCP  ")).toBe(normalizeConceptName("TCP"));
  });

  it("does not collapse 'TCP protocol' into 'TCP' — deterministic normalization is conservative", () => {
    expect(normalizeConceptName("TCP protocol")).not.toBe(normalizeConceptName("TCP"));
  });

  it("strips punctuation and collapses internal whitespace", () => {
    expect(normalizeConceptName("Firewalls!!")).toBe(normalizeConceptName("Firewalls"));
    expect(normalizeConceptName("Three   Way   Handshake")).toBe("three way handshake");
  });
});

describe("mergeByNormalizedName", () => {
  it("merges a concept repeated across chunks into one, combining evidence", () => {
    const candidates: CandidateConcept[] = [
      { name: "TCP", description: "A protocol.", difficulty: 2, evidence: [{ chunkId: "c1", text: "TCP is a protocol." }] },
      { name: "tcp", description: "A protocol.", difficulty: 3, evidence: [{ chunkId: "c2", text: "TCP also does X." }] },
      { name: "Firewalls", description: "Filters traffic.", difficulty: 3, evidence: [{ chunkId: "c3", text: "..." }] },
    ];

    const { concepts, mergedCount } = mergeByNormalizedName(candidates);

    expect(concepts).toHaveLength(2);
    expect(mergedCount).toBe(1);

    const tcp = concepts.find((concept) => concept.normalizedName === "tcp");
    expect(tcp?.evidence).toHaveLength(2);
  });
});

describe("mergeSemanticDuplicates", () => {
  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("merges concepts grouped with confidence at or above the threshold", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        duplicateGroups: [
          { canonicalName: "TCP", duplicateNames: ["Transmission Control Protocol"], confidence: 0.95 },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    const concepts = [
      { name: "TCP", normalizedName: "tcp", description: "...", difficulty: 2, evidence: [{ chunkId: "c1", text: "a" }] },
      {
        name: "Transmission Control Protocol",
        normalizedName: "transmission control protocol",
        description: "...",
        difficulty: 2,
        evidence: [{ chunkId: "c2", text: "b" }],
      },
    ];

    const { concepts: merged, mergedCount } = await mergeSemanticDuplicates("Course", concepts, 0.9);

    expect(mergedCount).toBe(1);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("TCP");
    expect(merged[0].evidence).toHaveLength(2);
  });

  it("prefers false duplicates: does not merge groups below the confidence threshold", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        duplicateGroups: [{ canonicalName: "TCP", duplicateNames: ["Networking basics"], confidence: 0.5 }],
      },
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    const concepts = [
      { name: "TCP", normalizedName: "tcp", description: "...", difficulty: 2, evidence: [] },
      { name: "Networking basics", normalizedName: "networking basics", description: "...", difficulty: 1, evidence: [] },
    ];

    const { concepts: merged, mergedCount } = await mergeSemanticDuplicates("Course", concepts, 0.9);

    expect(mergedCount).toBe(0);
    expect(merged).toHaveLength(2);
  });

  it("skips the AI call entirely with fewer than two concepts", async () => {
    const single = [{ name: "TCP", normalizedName: "tcp", description: "...", difficulty: 2, evidence: [] }];
    const { mergedCount } = await mergeSemanticDuplicates("Course", single, 0.9);

    expect(mergedCount).toBe(0);
    expect(extractStructured).not.toHaveBeenCalled();
  });
});
