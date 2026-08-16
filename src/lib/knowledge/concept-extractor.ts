import { extractStructuredWithRetry, StructuredExtractionFailedError } from "@/lib/ai/structured-retry";
import { buildConceptExtractionPrompt, ConceptExtractionSchema, type ChunkInput } from "@/lib/ai/prompts/concept-extraction";
import { CHUNKS_PER_CONCEPT_EXTRACTION_BATCH } from "./config";

export interface CandidateConceptEvidence {
  chunkId: string;
  text: string;
}

export interface CandidateConcept {
  name: string;
  description: string;
  difficulty: number;
  evidence: CandidateConceptEvidence[];
}

function batchOf<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function toConcepts(data: { concepts: { name: string; description: string; difficulty: number; evidence: { chunkId: string; text: string }[] }[] }, knownChunkIds: Set<string>): CandidateConcept[] {
  const results: CandidateConcept[] = [];
  for (const concept of data.concepts) {
    const evidence = concept.evidence.filter((entry) => knownChunkIds.has(entry.chunkId));
    if (evidence.length === 0) {
      continue;
    }
    results.push({ name: concept.name, description: concept.description, difficulty: concept.difficulty, evidence });
  }
  return results;
}

/**
 * Extracts concepts from a single batch of chunks, with bounded resilience:
 * `extractStructuredWithRetry` already covers a transient/truncated
 * response (identical retry, then a "respond with complete JSON" retry). If
 * the batch still fails, this batch is split in half and each half is
 * retried independently — a batch of one chunk that still fails is skipped
 * (that chunk simply contributes no candidate concepts) rather than
 * crashing the whole course's extraction over one bad chunk.
 */
async function extractBatch(
  courseTitle: string,
  batch: ChunkInput[],
  options: { userId?: string | null } | undefined,
): Promise<CandidateConcept[]> {
  const knownChunkIds = new Set(batch.map((chunk) => chunk.id));
  const { system, prompt } = buildConceptExtractionPrompt(courseTitle, batch);

  try {
    const { data } = await extractStructuredWithRetry({
      model: "fast",
      system,
      prompt,
      schema: ConceptExtractionSchema,
      requestType: "concept_extraction",
      userId: options?.userId,
    });
    return toConcepts(data, knownChunkIds);
  } catch (error) {
    if (!(error instanceof StructuredExtractionFailedError) || batch.length <= 1) {
      console.error(`Concept extraction failed for a batch of ${batch.length} chunk(s) in course "${courseTitle}", skipping:`, error);
      return [];
    }
    const mid = Math.ceil(batch.length / 2);
    const [first, second] = await Promise.all([
      extractBatch(courseTitle, batch.slice(0, mid), options),
      extractBatch(courseTitle, batch.slice(mid), options),
    ]);
    return [...first, ...second];
  }
}

/**
 * Extracts candidate concepts from a course's document chunks, in batches
 * (never the whole course in one request — spec §8). Every concept's
 * evidence is re-checked against the real chunk IDs it was given; evidence
 * pointing at a chunk that wasn't in the batch is dropped as a hallucination
 * guard rather than trusted. A single unrecoverable batch degrades to "no
 * concepts from that batch" instead of aborting the whole course.
 */
export async function extractConceptsFromChunks(
  courseTitle: string,
  chunks: ChunkInput[],
  options?: { userId?: string | null; onProgress?: (batchesProcessed: number, totalBatches: number) => void },
): Promise<CandidateConcept[]> {
  const batches = batchOf(chunks, CHUNKS_PER_CONCEPT_EXTRACTION_BATCH);
  const results: CandidateConcept[] = [];
  let processed = 0;

  for (const batch of batches) {
    const concepts = await extractBatch(courseTitle, batch, options);
    results.push(...concepts);
    processed += 1;
    options?.onProgress?.(processed, batches.length);
  }

  return results;
}
