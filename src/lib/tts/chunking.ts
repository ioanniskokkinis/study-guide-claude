/**
 * Sentence-boundary-safe splitting for long Tutor responses (Phase 14
 * §13). Deliberately simple — this is not the sentence-level *streaming*
 * TTS optimization the spec explicitly defers to a later phase; it only
 * keeps any single provider request within `TTS_MAX_CHARACTERS` without
 * cutting a sentence (or a word) in half, so nothing the student reads is
 * silently dropped.
 */
export function splitForTts(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)/g) ?? [text];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // A single "sentence" longer than the whole budget (no punctuation for a long stretch) — fall back to a
      // word-boundary split so we still never cut mid-word.
      if (current.trim().length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      const words = sentence.split(/\s+/);
      let wordChunk = "";
      for (const word of words) {
        if ((wordChunk + " " + word).trim().length > maxChars && wordChunk.trim().length > 0) {
          chunks.push(wordChunk.trim());
          wordChunk = word;
        } else {
          wordChunk = wordChunk ? `${wordChunk} ${word}` : word;
        }
      }
      if (wordChunk.trim().length > 0) current = wordChunk;
      continue;
    }

    if ((current + sentence).length > maxChars && current.trim().length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}
