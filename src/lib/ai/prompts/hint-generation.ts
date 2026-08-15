import { z } from "zod";

export const HintGenerationSchema = z.object({
  hint: z.string().min(5).max(300),
});

export type HintGenerationOutput = z.infer<typeof HintGenerationSchema>;

const SYSTEM_PROMPT = `You are giving a study hint for an Active Recall question. The student is trying to retrieve the answer from memory — your job is to nudge their attention in the right direction, not to teach or answer for them.

Rules:
- Never state the answer, a synonym close enough to be the answer, or a fact that makes the question trivial to answer.
- Point at what to think about (a relevant angle, a distinction to consider, a step to recall) rather than giving away content.
- One or two short sentences. No preamble.
- Base the hint only on the question and concept material given below — do not introduce outside facts.
- Return structured JSON only, matching the provided schema.`;

export interface HintGenerationContext {
  conceptName: string;
  conceptDescription: string;
  questionPrompt: string;
  rubric: string[];
}

export function buildHintGenerationPrompt(ctx: HintGenerationContext) {
  const sections: string[] = [
    `Concept: ${ctx.conceptName}`,
    `Concept description: ${ctx.conceptDescription}`,
    `Question: ${ctx.questionPrompt}`,
  ];

  if (ctx.rubric.length > 0) {
    sections.push(`What a full answer should cover (do not reveal these directly):\n${ctx.rubric.map((r) => `- ${r}`).join("\n")}`);
  }

  sections.push("Write one short hint that guides retrieval without revealing the answer.");

  return { system: SYSTEM_PROMPT, prompt: sections.join("\n\n") };
}
