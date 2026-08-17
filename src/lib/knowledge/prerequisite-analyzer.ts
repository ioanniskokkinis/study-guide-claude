import { extractStructuredWithRetry, StructuredExtractionFailedError } from "@/lib/ai/structured-retry";
import { AI_TIMEOUT_MS } from "@/lib/ai/timeout-budgets";
import {
  buildPrerequisiteAnalysisPrompt,
  PrerequisiteAnalysisSchema,
  type ConceptSummaryInput,
} from "@/lib/ai/prompts/prerequisite-analysis";
import { MAX_CONCEPTS_PER_RELATIONSHIP_BATCH } from "./config";

export interface CandidatePrerequisite {
  prerequisiteConceptName: string;
  dependentConceptName: string;
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
 * Extracts prerequisite dependencies between a course's already-persisted
 * concepts. This is a dedicated pass (not part of relationship-extractor)
 * because prerequisite detection needs stricter reasoning — "appears
 * earlier" or "is related to" must not be treated as "is a prerequisite of"
 * (spec §13).
 */
export async function extractPrerequisites(
  courseTitle: string,
  concepts: ConceptSummaryInput[],
  options?: { userId?: string | null },
): Promise<CandidatePrerequisite[]> {
  const knownNames = new Set(concepts.map((concept) => concept.name));
  const results: CandidatePrerequisite[] = [];

  for (const batch of batchOf(concepts, MAX_CONCEPTS_PER_RELATIONSHIP_BATCH)) {
    const { system, prompt } = buildPrerequisiteAnalysisPrompt(courseTitle, batch);

    let data;
    try {
      ({ data } = await extractStructuredWithRetry({
        model: "default",
        system,
        prompt,
        schema: PrerequisiteAnalysisSchema,
        requestType: "prerequisite_analysis",
        effort: "medium",
        userId: options?.userId,
        timeoutMs: AI_TIMEOUT_MS.KNOWLEDGE_EXTRACTION,
      }));
    } catch (error) {
      if (!(error instanceof StructuredExtractionFailedError)) throw error;
      console.error(`Prerequisite analysis failed for a batch of ${batch.length} concept(s) in course "${courseTitle}", skipping:`, error);
      continue;
    }

    for (const prerequisite of data.prerequisites) {
      if (
        !knownNames.has(prerequisite.prerequisiteConceptName) ||
        !knownNames.has(prerequisite.dependentConceptName)
      ) {
        continue;
      }
      results.push(prerequisite);
    }
  }

  return results;
}
