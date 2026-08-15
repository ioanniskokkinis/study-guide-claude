import { extractStructured } from "@/lib/ai/claude";
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

    const { data } = await extractStructured({
      model: "default",
      system,
      prompt,
      schema: PrerequisiteAnalysisSchema,
      requestType: "prerequisite_analysis",
      effort: "medium",
      userId: options?.userId,
    });

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
