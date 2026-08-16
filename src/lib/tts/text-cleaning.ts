/**
 * Deterministic Markdown/metadata stripping for TTS (Phase 14 §12) —
 * never an AI call. Covers the same construct vocabulary
 * src/lib/markdown/safe-markdown.tsx (Phase 13) understands, but produces
 * plain speech text instead of React elements. Only ever runs on a
 * persisted TutorMessage's own `content` — never internal metadata,
 * evaluation reasoning, or tool results, since those never reach
 * `TutorMessage.content` in the first place (spec §5).
 */

/** Ensures a line reads as a complete spoken sentence before it's joined with the next one. */
function withTerminalPunctuation(line: string): string {
  return /[.!?:]$/.test(line) ? line : `${line}.`;
}

export function toSpeechText(markdown: string): string {
  let text = markdown;

  // Fenced code blocks — code isn't meaningfully speakable character by character; say so instead of reading punctuation soup.
  text = text.replace(/```[\w-]*\n[\s\S]*?```/g, "Code block omitted.");
  text = text.replace(/```[\w-]*\n[\s\S]*$/g, "Code block omitted."); // unterminated fence at the end (defensive — shouldn't occur in a persisted message)

  // Headings: "### Key idea" -> "Key idea"
  text = text.replace(/^#{1,6}\s+(.*)$/gm, "$1");

  // Bold / italic emphasis markers -> spoken as plain text (spec's own example: **important concept** -> "important concept")
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1");

  // Inline code -> bare content
  text = text.replace(/`([^`]+)`/g, "$1");

  // Links [text](url) -> spoken as just the link text; the destination isn't read aloud.
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Blockquote markers
  text = text.replace(/^>\s?/gm, "");

  // List markers -> strip the bullet/number, keep the content as its own line.
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");

  // The deterministic "Source: ..." citation line tutor-orchestrator.ts appends (Phase 7/11) — a citation trail for reading, not for hearing.
  text = text.replace(/^Source:.*$/gm, "");

  // Any remaining bare URL (not a Markdown link) — not read aloud.
  text = text.replace(/https?:\/\/\S+/g, "");

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines
    .map(withTerminalPunctuation)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
