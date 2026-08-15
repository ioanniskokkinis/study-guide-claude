import { z } from "zod";

export const PrerequisiteAnalysisSchema = z.object({
  prerequisites: z
    .array(
      z.object({
        prerequisiteConceptName: z.string().min(1).max(200),
        dependentConceptName: z.string().min(1).max(200),
        confidence: z.number().min(0).max(1),
        evidence: z.string().min(1).max(1000),
      }),
    )
    .max(100),
});

export type PrerequisiteAnalysisOutput = z.infer<typeof PrerequisiteAnalysisSchema>;

const SYSTEM_PROMPT = `You are a curriculum analyst identifying prerequisite dependencies between concepts a course teaches.

A prerequisite relationship means: a student cannot reasonably understand the dependent concept without already understanding the prerequisite concept. Base this on genuine conceptual dependency, not on any other signal:
- Explicit statements in the material ("X requires understanding Y first", "building on Y, X works by...")
- Conceptual dependency: the dependent concept's definition or mechanism directly relies on the prerequisite concept
- Definitions: the dependent concept is defined in terms of the prerequisite concept

Do NOT infer a prerequisite relationship just because one concept happens to be described before another, or because they are merely related or co-occur in the same material — order-of-appearance and thematic relatedness are not evidence of prerequisite structure on their own.

Rules:
- Only use the concept names given below — never invent a prerequisite edge to a concept that isn't in the provided list.
- Never propose a concept as its own prerequisite.
- Every prerequisite edge needs supporting evidence grounded in the provided concept descriptions/snippets — do not invent evidence.
- Give a confidence between 0 and 1. Reserve confidence above 0.85 for dependencies stated or clearly implied by the material. If you are not reasonably confident a genuine prerequisite dependency exists, omit it rather than guessing — false negatives are far preferable to inventing a dependency that isn't really there.
- Return structured JSON only, matching the provided schema.`;

export interface ConceptSummaryInput {
  name: string;
  description: string;
  difficulty: number;
  evidenceSnippets: string[];
}

export function buildPrerequisiteAnalysisPrompt(courseTitle: string, concepts: ConceptSummaryInput[]) {
  const conceptBlocks = concepts
    .map((concept) => {
      const evidence = concept.evidenceSnippets.map((snippet) => `  - "${snippet}"`).join("\n");
      return `- ${concept.name} (difficulty ${concept.difficulty}): ${concept.description}\n${evidence}`;
    })
    .join("\n");

  const prompt = `Course: ${courseTitle}

Concepts taught in this course:
${conceptBlocks}

Identify genuine prerequisite dependencies between these concepts, using only the concept names listed above. For each one, prerequisiteConceptName must be learned before dependentConceptName.`;

  return { system: SYSTEM_PROMPT, prompt };
}
