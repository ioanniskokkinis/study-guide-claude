export interface ChunkMetadata {
  source: string;
  chunkIndex: number;
  [key: string]: string | number;
}

export interface ChunkResult {
  index: number;
  text: string;
  tokenCount: number;
  metadata: ChunkMetadata;
}

export interface ChunkOptions {
  /** Target chunk size in characters. */
  chunkSize: number;
  /** Characters of trailing context carried into the next chunk. */
  chunkOverlap: number;
  /** Recorded in each chunk's metadata, e.g. the source filename. */
  source: string;
}

/**
 * Deterministic, paragraph-aware text chunker. No LLM calls: chunk
 * boundaries are decided purely from paragraph/sentence/word structure so
 * ingestion is fast, cheap, and reproducible.
 */
export function chunkText(text: string, options: ChunkOptions): ChunkResult[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const pieces = paragraphs.flatMap((paragraph) =>
    splitOversizedParagraph(paragraph, options.chunkSize),
  );

  const groups = groupPieces(pieces, options.chunkSize);

  const chunks: ChunkResult[] = [];
  let previousTail = "";

  groups.forEach((group, index) => {
    const body = group.join("\n\n");
    const text = previousTail ? `${previousTail}\n\n${body}` : body;

    chunks.push({
      index,
      text,
      tokenCount: estimateTokenCount(text),
      metadata: { source: options.source, chunkIndex: index },
    });

    previousTail = options.chunkOverlap > 0 ? takeOverlapTail(body, options.chunkOverlap) : "";
  });

  return chunks;
}

function groupPieces(pieces: string[], chunkSize: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const piece of pieces) {
    const joinerLength = current.length > 0 ? 2 : 0;
    if (current.length > 0 && currentLength + joinerLength + piece.length > chunkSize) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(piece);
    currentLength += piece.length + (current.length > 1 ? 2 : 0);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

/** Trailing context for the next chunk, trimmed so it starts on a word boundary. */
function takeOverlapTail(text: string, overlapSize: number): string {
  if (text.length <= overlapSize) {
    return text;
  }
  const rawTail = text.slice(text.length - overlapSize);
  const firstWhitespace = rawTail.search(/\s/);
  return firstWhitespace === -1 ? rawTail : rawTail.slice(firstWhitespace + 1);
}

/** Splits a paragraph that alone exceeds chunkSize, preferring sentence boundaries. */
function splitOversizedParagraph(paragraph: string, chunkSize: number): string[] {
  if (paragraph.length <= chunkSize) {
    return [paragraph];
  }

  const sentences = paragraph.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 0);
  const pieces: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > chunkSize && current) {
      pieces.push(current);
      current = sentence;
    } else {
      current = candidate;
    }

    if (current.length > chunkSize) {
      pieces.push(...splitByWords(current, chunkSize));
      current = "";
    }
  }

  if (current) {
    pieces.push(current);
  }

  return pieces;
}

/** Last resort for a single "sentence" still longer than chunkSize: split on whitespace. */
function splitByWords(text: string, chunkSize: number): string[] {
  const words = text.split(/\s+/);
  const pieces: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > chunkSize && current) {
      pieces.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    pieces.push(current);
  }

  return pieces;
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
