import { describe, expect, it } from "vitest";
import { toSpeechText } from "@/lib/tts/text-cleaning";

/** Phase 14 §12 — deterministic (non-AI) markdown/metadata stripping for speech. */
describe("toSpeechText (Phase 14 §12)", () => {
  it("matches the spec's own worked example", () => {
    const markdown = "### Key idea\n\n- Memory improves with retrieval practice.\n- Spaced repetition strengthens recall.";
    expect(toSpeechText(markdown)).toBe("Key idea. Memory improves with retrieval practice. Spaced repetition strengthens recall.");
  });

  it("strips bold/italic/inline-code markers, keeping the content", () => {
    expect(toSpeechText("This is **important concept** and *emphasis* and `code`.")).toBe(
      "This is important concept and emphasis and code.",
    );
  });

  it("replaces fenced code blocks with a spoken placeholder instead of reading punctuation", () => {
    const result = toSpeechText("Here is an example:\n\n```js\nconst x = 1;\n```\n\nDone.");
    expect(result).toContain("Code block omitted.");
    expect(result).not.toContain("const x");
  });

  it("reads link text but drops the URL destination", () => {
    expect(toSpeechText("See [the docs](https://example.com/docs) for more.")).toBe("See the docs for more.");
  });

  it("strips bare (non-Markdown) URLs entirely", () => {
    const result = toSpeechText("Check https://example.com/page for details.");
    expect(result).not.toContain("https://");
    expect(result).toBe("Check for details.");
  });

  it("removes the deterministic 'Source: ...' citation line appended by the orchestrator — a citation trail, not something to hear", () => {
    const result = toSpeechText("Firewalls filter traffic.\n\nSource: networking-101.pdf, page 4");
    expect(result).not.toContain("Source:");
    expect(result).toContain("Firewalls filter traffic.");
  });

  it("converts numbered and bulleted lists into natural sentence-per-line speech", () => {
    expect(toSpeechText("1. First step\n2. Second step\n- A bullet")).toBe("First step. Second step. A bullet.");
  });

  it("strips blockquote markers", () => {
    expect(toSpeechText("> An important quote")).toBe("An important quote.");
  });

  it("returns an empty string for content that is purely markdown noise with no readable text", () => {
    expect(toSpeechText("   \n\n   ")).toBe("");
  });

  it("never invokes an AI call — this is a pure synchronous function", () => {
    // Type-level guarantee doubles as documentation: toSpeechText returns a
    // plain string synchronously, never a Promise, so it cannot be backed by
    // a network/AI call (spec §12: "must NOT use another AI call").
    const result = toSpeechText("Plain text.");
    expect(typeof result).toBe("string");
  });
});
