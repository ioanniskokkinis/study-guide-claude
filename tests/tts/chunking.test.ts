import { describe, expect, it } from "vitest";
import { splitForTts } from "@/lib/tts/chunking";

/**
 * Phase 14 §13 — sentence-boundary-safe splitting for long Tutor responses.
 * Deliberately not the sentence-level *streaming* TTS optimization the spec
 * defers to a later phase; just keeps any single request under budget
 * without silently dropping or mangling content.
 */
describe("splitForTts (Phase 14 §13)", () => {
  it("returns the whole text unchanged as a single part when under the limit", () => {
    const text = "Short response.";
    expect(splitForTts(text, 2000)).toEqual([text]);
  });

  it("splits at sentence boundaries — every part ends with sentence punctuation", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const parts = splitForTts(text, 20);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.trim()).toMatch(/[.!?]$/);
    }
  });

  it("never drops any sentence across parts", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const parts = splitForTts(text, 60);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("falls back to word-boundary splitting for a single 'sentence' longer than the whole budget, never cutting a word in half", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const longSentence = `${words.join(" ")}.`;
    const parts = splitForTts(longSentence, 40);
    expect(parts.length).toBeGreaterThan(1);
    const rejoinedWords = parts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map((w) => w.replace(/[.!?]+$/, ""));
    for (const word of words) {
      expect(rejoinedWords).toContain(word);
    }
  });

  it("keeps each part at or under the configured max characters", () => {
    const text = Array.from({ length: 50 }, (_, i) => `This is sentence ${i} in a long tutor explanation.`).join(" ");
    const parts = splitForTts(text, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(200);
    }
  });

  it("never produces an empty part", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Sentence ${i}.`).join(" ");
    const parts = splitForTts(text, 30);
    for (const part of parts) {
      expect(part.trim().length).toBeGreaterThan(0);
    }
  });
});
