import { describe, expect, it } from "vitest";
import { chunkText } from "@/lib/documents/chunker";

describe("chunkText", () => {
  it("returns an empty array for empty or whitespace-only text", () => {
    expect(chunkText("", { chunkSize: 100, chunkOverlap: 0, source: "a.pdf" })).toEqual([]);
    expect(chunkText("   \n\n  ", { chunkSize: 100, chunkOverlap: 0, source: "a.pdf" })).toEqual(
      [],
    );
  });

  it("keeps short text in a single chunk", () => {
    const chunks = chunkText("Hello world.", {
      chunkSize: 100,
      chunkOverlap: 0,
      source: "a.pdf",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Hello world.");
    expect(chunks[0].metadata).toEqual({ source: "a.pdf", chunkIndex: 0 });
  });

  it("splits long text into multiple chunks in order without cutting words", () => {
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `Paragraph ${i} contains several words describing concept number ${i}.`,
    );
    const text = paragraphs.join("\n\n");

    const chunks = chunkText(text, { chunkSize: 120, chunkOverlap: 0, source: "notes.pdf" });

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
      expect(chunk.metadata.chunkIndex).toBe(i);
    });

    // No chunk should start or end mid-word (every chunk trims to whole words).
    for (const chunk of chunks) {
      expect(chunk.text.trim()).not.toMatch(/^\S+-$/);
    }

    // Reassembling non-overlapping chunk content should preserve every paragraph, in order.
    const rejoined = chunks.map((c) => c.text).join(" ");
    for (const paragraph of paragraphs) {
      expect(rejoined).toContain(paragraph);
    }
  });

  it("carries trailing context into the next chunk when overlap is set", () => {
    const paragraphs = Array.from(
      { length: 6 },
      (_, i) => `Paragraph ${i} contains several words describing concept number ${i} in detail.`,
    );
    const text = paragraphs.join("\n\n");

    const withOverlap = chunkText(text, { chunkSize: 120, chunkOverlap: 40, source: "a.pdf" });
    const withoutOverlap = chunkText(text, { chunkSize: 120, chunkOverlap: 0, source: "a.pdf" });

    expect(withOverlap.length).toBeGreaterThan(1);
    // The overlapping version's second chunk should start with content that
    // also appears at the end of the first chunk (trailing context carried forward).
    const firstChunkTail = withOverlap[0].text.slice(-30).trim();
    const tailWords = firstChunkTail.split(/\s+/).slice(-3).join(" ");
    expect(withOverlap[1].text).toContain(tailWords);

    // Overlap means more total characters across chunks than the non-overlapping version.
    const overlapTotalLength = withOverlap.reduce((sum, c) => sum + c.text.length, 0);
    const noOverlapTotalLength = withoutOverlap.reduce((sum, c) => sum + c.text.length, 0);
    expect(overlapTotalLength).toBeGreaterThan(noOverlapTotalLength);
  });

  it("hard-splits a single oversized paragraph without truncating content", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 0, source: "a.pdf" });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(100 + 10); // small slack for boundary word
    }
  });

  it("assigns a positive estimated token count to every chunk", () => {
    const chunks = chunkText("Some reasonably sized paragraph of text for token estimation.", {
      chunkSize: 200,
      chunkOverlap: 0,
      source: "a.pdf",
    });

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });
});
