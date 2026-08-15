import type { z } from "zod";
import { extractStructured } from "@/lib/ai/claude";
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

    const { data } = await extractStructured({
      model: "default",
      system,
      prompt,
      schema: RelationshipExtractionSchema,
      requestType: "relationship_extraction",
      effort: "medium",
      userId: options?.userId,
    });

    for (const relationship of data.relationships) {
      if (!knownNames.has(relationship.sourceConceptName) || !knownNames.has(relationship.targetConceptName)) {
        continue;
      }
      results.push(relationship);
    }
  }

  return results;
}
