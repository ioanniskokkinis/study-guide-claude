import { extractStructured } from "@/lib/ai/claude";
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

/**
 * Extracts candidate concepts from a course's document chunks, in batches
 * (never the whole course in one request — spec §8). Every concept's
 * evidence is re-checked against the real chunk IDs it was given; evidence
 * pointing at a chunk that wasn't in the batch is dropped as a hallucination
 * guard rather than trusted.
 */
export async function extractConceptsFromChunks(
  courseTitle: string,
  chunks: ChunkInput[],
  options?: { userId?: string | null },
): Promise<CandidateConcept[]> {
  const results: CandidateConcept[] = [];

  for (const batch of batchOf(chunks, CHUNKS_PER_CONCEPT_EXTRACTION_BATCH)) {
    const knownChunkIds = new Set(batch.map((chunk) => chunk.id));
    const { system, prompt } = buildConceptExtractionPrompt(courseTitle, batch);

    const { data } = await extractStructured({
      model: "fast",
      system,
      prompt,
      schema: ConceptExtractionSchema,
      requestType: "concept_extraction",
      userId: options?.userId,
    });

    for (const concept of data.concepts) {
      const evidence = concept.evidence.filter((entry) => knownChunkIds.has(entry.chunkId));
      if (evidence.length === 0) {
        continue;
      }
      results.push({
        name: concept.name,
        description: concept.description,
        difficulty: concept.difficulty,
        evidence,
      });
    }
  }

  return results;
}
