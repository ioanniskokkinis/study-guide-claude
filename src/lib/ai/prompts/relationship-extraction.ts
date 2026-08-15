import { z } from "zod";

/**
 * Prerequisite edges are deliberately excluded from this schema — they get
 * their own dedicated pass (prerequisite-analysis.ts) with stricter,
 * direction-specific reasoning. This enum can't emit "prerequisite" at all.
 */
export const GeneralRelationshipTypeSchema = z.enum([
  "contains",
  "related",
  "example_of",
  "contrasts_with",
  "causes",
  "part_of",
  "applies_to",
]);

export const RelationshipExtractionSchema = z.object({
  relationships: z
    .array(
      z.object({
        sourceConceptName: z.string().min(1).max(200),
        targetConceptName: z.string().min(1).max(200),
        relationshipType: GeneralRelationshipTypeSchema,
        confidence: z.number().min(0).max(1),
        evidence: z.string().min(1).max(1000),
      }),
    )
    .max(150),
});

export type RelationshipExtractionOutput = z.infer<typeof RelationshipExtractionSchema>;

const SYSTEM_PROMPT = `You are a curriculum analyst identifying relationships between concepts a course teaches.

Relationship types and their meaning:
- contains: the source concept encompasses the target as a sub-topic
- part_of: the source concept is a component of the target (the inverse relationship of "contains")
- related: source and target are meaningfully connected but neither contains, requires, nor causes the other
- example_of: the target is a specific example or instance of the source
- contrasts_with: source and target are commonly compared or contrasted with each other
- causes: the source causes, triggers, or leads to the target
- applies_to: the source is a technique or method applied to the target

Rules:
- Only use the concept names given below — never invent a relationship to a concept that isn't in the provided list.
- Do NOT classify prerequisite ("must learn X before Y") relationships here; that is out of scope for this pass. If two concepts have a strict learning-order dependency and no other listed relationship type fits, omit the relationship entirely rather than mislabeling it.
- Every relationship needs supporting evidence grounded in the provided concept descriptions/snippets — do not invent evidence.
- Give a confidence between 0 and 1. Reserve confidence above 0.85 for relationships stated or clearly implied by the material; use lower confidence for plausible-but-uncertain inferences. If you are not reasonably confident, omit the relationship rather than guessing.
- Do not create duplicate or self-referencing relationships.
- Return structured JSON only, matching the provided schema.`;

export interface ConceptSummaryInput {
  name: string;
  description: string;
  difficulty: number;
  evidenceSnippets: string[];
}

export function buildRelationshipExtractionPrompt(courseTitle: string, concepts: ConceptSummaryInput[]) {
  const conceptBlocks = concepts
    .map((concept) => {
      const evidence = concept.evidenceSnippets.map((snippet) => `  - "${snippet}"`).join("\n");
      return `- ${concept.name} (difficulty ${concept.difficulty}): ${concept.description}\n${evidence}`;
    })
    .join("\n");

  const prompt = `Course: ${courseTitle}

Concepts taught in this course:
${conceptBlocks}

Identify relationships between these concepts, using only the concept names listed above.`;

  return { system: SYSTEM_PROMPT, prompt };
}
