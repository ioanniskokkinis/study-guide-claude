import { z } from "zod";

export const ConceptExtractionSchema = z.object({
  concepts: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().min(1).max(2000),
        difficulty: z.number().int().min(1).max(5),
        evidence: z
          .array(
            z.object({
              chunkId: z.string().min(1),
              text: z.string().min(1).max(1000),
            }),
          )
          .min(1)
          .max(5),
      }),
    )
    .max(40),
});

export type ConceptExtractionOutput = z.infer<typeof ConceptExtractionSchema>;

const SYSTEM_PROMPT = `You are a curriculum analyst extracting the concepts a course teaches, from raw course material.

Rules:
- Only extract concepts that are explicitly present in the provided material. Do not use outside/general knowledge to invent concepts the material doesn't actually cover.
- Every concept must include at least one evidence entry citing the exact chunkId it came from, with a short supporting quote or close paraphrase from that chunk's text — never fabricate evidence.
- Write each description in your own words, 1-3 sentences, capturing what the material actually says.
- Estimate difficulty 1-5 (1 = foundational/definitional, 5 = advanced/synthesizes many prerequisites) based only on the conceptual complexity visible in the material.
- Prefer distinct, teachable concepts (e.g. "TCP three-way handshake") over vague topic labels (e.g. "networking").
- If the material contains no clear teachable concepts, return an empty concepts array — do not force extraction.
- Return structured JSON only, matching the provided schema.`;

export interface ChunkInput {
  id: string;
  text: string;
}

export function buildConceptExtractionPrompt(courseTitle: string, chunks: ChunkInput[]) {
  const chunkBlocks = chunks
    .map((chunk) => `Chunk ${chunk.id}:\n"""\n${chunk.text}\n"""`)
    .join("\n\n");

  const prompt = `Course: ${courseTitle}

${chunkBlocks}

Extract the distinct, teachable concepts explicitly covered in the chunks above.`;

  return { system: SYSTEM_PROMPT, prompt };
}
