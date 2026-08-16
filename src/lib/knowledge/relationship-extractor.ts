import type { z } from "zod";
import { extractStructuredWithRetry, StructuredExtractionFailedError } from "@/lib/ai/structured-retry";
import {
  buildRelationshipExtractionPrompt,
  RelationshipExtractionSchema,
  type ConceptSummaryInput,
  type GeneralRelationshipTypeSchema,
} from "@/lib/ai/prompts/relationship-extraction";
import { MAX_CONCEPTS_PER_RELATIONSHIP_BATCH } from "./config";

export interface CandidateRelationship {
  sourceConceptName: string;
  targetConceptName: string;
  relationshipType: z.infer<typeof GeneralRelationshipTypeSchema>;
  confidence: number;
  evidence: string;
}

function batchOf<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Extracts general (non-prerequisite) relationships between a course's
 * already-persisted concepts. Concepts are referenced by name — candidates
 * pointing at a name outside the known set are dropped (never trust
 * arbitrary model output).
 */
export async function extractRelationships(
  courseTitle: string,
  concepts: ConceptSummaryInput[],
  options?: { userId?: string | null },
): Promise<CandidateRelationship[]> {
  const knownNames = new Set(concepts.map((concept) => concept.name));
  const results: CandidateRelationship[] = [];

  for (const batch of batchOf(concepts, MAX_CONCEPTS_PER_RELATIONSHIP_BATCH)) {
    const { system, prompt } = buildRelationshipExtractionPrompt(courseTitle, batch);

    let data;
    try {
      ({ data } = await extractStructuredWithRetry({
        model: "default",
        system,
        prompt,
        schema: RelationshipExtractionSchema,
        requestType: "relationship_extraction",
        effort: "medium",
        userId: options?.userId,
      }));
    } catch (error) {
      if (!(error instanceof StructuredExtractionFailedError)) throw error;
      // A truncated/invalid response for one batch of concepts just means those relationships are
      // missing, not that the whole graph build should fail — skip this batch and keep going.
      console.error(`Relationship extraction failed for a batch of ${batch.length} concept(s) in course "${courseTitle}", skipping:`, error);
      continue;
    }

    for (const relationship of data.relationships) {
      if (!knownNames.has(relationship.sourceConceptName) || !knownNames.has(relationship.targetConceptName)) {
        continue;
      }
      results.push(relationship);
    }
  }

  return results;
}
